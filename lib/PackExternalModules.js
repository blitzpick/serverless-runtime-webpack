const PromiseHelper = require("./PromiseHelper");
const _ = require("lodash");
const path = require("path");
const childProcess = require("child_process");
const fse = require("fs-extra");
const isBuiltinModule = require("is-builtin-module");

function promiseFromChildProcess(child) {
    return new Promise((resolve, reject) => {
        child.addListener('error', (code, signal) => {
            console.log('ChildProcess error', code, signal);
            reject();
        });
        child.addListener('exit', (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                reject();
            }
        });
    });
}

function rebaseFileReferences(pathToPackageRoot, moduleVersion) {
    if (/^file:[^/]{2}/.test(moduleVersion)) {
        const filePath = _.replace(moduleVersion, /^file:/, "");

        return _.replace(`file:${pathToPackageRoot}/${filePath}`, /\\/g, "/");
    }

    return moduleVersion;
}

function rebasePackageLock(pathToPackageRoot, module) {
    if (module.version) {
        module.version = rebaseFileReferences(pathToPackageRoot, module.version);
    }

    if (module.dependencies) {
        _.forIn(module.dependencies, (moduleDependency) => {
            rebasePackageLock(pathToPackageRoot, moduleDependency);
        });
    }
}

/**
 * Add the given modules to a package json's dependencies.
 */
function addModulesToPackageJson(externalModules, packageJson, pathToPackageRoot) {
    _.forEach(externalModules, (externalModule) => {
        const splitModule = _.split(externalModule, "@");
        // If we have a scoped module we have to re-add the @
        if (_.startsWith(externalModule, "@")) {
            splitModule.splice(0, 1);
            splitModule[0] = `@${splitModule[0]}`;
        }
        let moduleVersion = _.join(_.tail(splitModule), "@");
        // We have to rebase file references to the target package.json
        moduleVersion = rebaseFileReferences(pathToPackageRoot, moduleVersion);
        packageJson.dependencies = packageJson.dependencies || {};
        packageJson.dependencies[_.first(splitModule)] = moduleVersion;
    });
}

/**
 * Remove a given list of excluded modules from a module list
 * @this - The active plugin instance
 */
function removeExcludedModules(modules, packageForceExcludes, log) {
    const excludedModules = _.remove(modules, (externalModule) => {
        const splitModule = _.split(externalModule, "@");
        // If we have a scoped module we have to re-add the @
        if (_.startsWith(externalModule, "@")) {
            splitModule.splice(0, 1);
            splitModule[0] = `@${splitModule[0]}`;
        }
        const moduleName = _.first(splitModule);

        return _.includes(packageForceExcludes, moduleName);
    });

    if (log && !_.isEmpty(excludedModules)) {
        console.log(`Excluding external modules: ${_.join(excludedModules, ", ")}`);
    }
}

/**
 * Resolve the needed versions of production depenencies for external modules.
 * @this - The active plugin instance
 */
function getProdModules(externalModules, packagePath, dependencyGraph) {
    const packageJsonPath = path.join(process.cwd(), packagePath);
    const packageJson = require(packageJsonPath);
    const prodModules = [];

    // only process the module stated in dependencies section
    if (!packageJson.dependencies) {
        return [];
    }

    // Get versions of all transient modules
    _.forEach(externalModules, (module) => {
        let moduleVersion = packageJson.dependencies[module.external];

        if (moduleVersion) {
            prodModules.push(`${module.external}@${moduleVersion}`);

            // Check if the module has any peer dependencies and include them too
            try {
                const modulePackagePath = path.join(
                    path.dirname(path.join(process.cwd(), packagePath)),
                    "node_modules",
                    module.external,
                    "package.json"
                );
                const peerDependencies = require(modulePackagePath).peerDependencies;
                if (!_.isEmpty(peerDependencies)) {
                    console.log(`Adding explicit peers for dependency ${module.external}`);
                    const peerModules = getProdModules.call(this, _.map(peerDependencies, (value, key) => ({ external: key })), packagePath, dependencyGraph);
                    Array.prototype.push.apply(prodModules, peerModules);
                }
            } catch (e) {
                console.log(`WARNING: Could not check for peer dependencies of ${module.external}`);
            }
        } else if (!packageJson.devDependencies || !packageJson.devDependencies[module.external]) {
            // Add transient dependencies if they appear not in the service's dev dependencies
            const originInfo = _.get(dependencyGraph, "dependencies", {})[module.origin] || {};
            moduleVersion = _.get(_.get(originInfo, "dependencies", {})[module.external], "version");
            if (!moduleVersion) {
                console.log(`WARNING: Could not determine version of module ${module.external}`);
            }
            prodModules.push(moduleVersion ? `${module.external}@${moduleVersion}` : module.external);
        }
    });

    return prodModules;
}

function getExternalModuleName(module) {
    const path = /^external "(.*)"$/.exec(module.identifier())[1];
    const pathComponents = path.split("/");
    const main = pathComponents[0];

    // this is a package within a namespace
    if (main.charAt(0) == "@") {
        return `${main}/${pathComponents[1]}`;
    }

    return main;
}

function isExternalModule(module) {
    return _.startsWith(module.identifier(), "external ") && !isBuiltinModule(getExternalModuleName(module));
}

/**
 * Find the original module that required the transient dependency. Returns
 * undefined if the module is a first level dependency.
 * @param {Object} issuer - Module issuer
 */
function findExternalOrigin(issuer) {
    if (!_.isNil(issuer) && _.startsWith(issuer.rawRequest, "./")) {
        return findExternalOrigin(issuer.issuer);
    }

    return issuer;
}

function getExternalModules(stats) {
    const externals = new Set();

    _.forEach(stats.compilation.chunks, (chunk) => {
        // Explore each module within the chunk (built inputs):
        _.forEach(chunk.modules, (module) => {
            if (isExternalModule(module)) {
                externals.add({
                    origin: _.get(findExternalOrigin(module.issuer), "rawRequest"),
                    external: getExternalModuleName(module)
                });
            }
        });
    });

    return Array.from(externals);
}

module.exports = {
    /**
   * We need a performant algorithm to install the packages for each single
   * function (in case we package individually).
   * (1) We fetch ALL packages needed by ALL functions in a first step
   * and use this as a base npm checkout. The checkout will be done to a
   * separate temporary directory with a package.json that contains everything.
   * (2) For each single compile we copy the whole node_modules to the compile
   * directory and create a (function) compile specific package.json and store
   * it in the compile directory. Now we start npm again there, and npm will just
   * remove the superfluous packages and optimize the remaining dependencies.
   * This will utilize the npm cache at its best and give us the needed results
   * and performance.
   */
    packExternalModules(func, stats, pathDist) {
        console.log("packExternalModules");

        const packageForceIncludes = [];
        const packageForceExcludes = [];

        const packagePath = "./package.json";
        const packageJsonPath = path.join(process.cwd(), packagePath);

        console.log(`Fetch dependency graph from ${packageJsonPath}`);
        // Get first level dependency graph
        const command = "npm ls -prod -json -depth=1"; // Only prod dependencies

        const ignoredNpmErrors = [
            { npmError: "invalid", log: false },
            { npmError: "extraneous", log: false },
            { npmError: "missing", log: false },
            { npmError: "peer dep missing", log: true }
        ];

        return (new Promise((resolve, reject) =>
            childProcess.exec(command, {
                cwd: path.dirname(packageJsonPath),
                maxBuffer: 200 * 1024,
                encoding: "utf8"
            }, (err, stdout, stderr) => {
                if (err) {
                    // Only exit with an error if we have critical npm errors for 2nd level inside
                    const errors = _.split(stderr, "\n");
                    const failed = _.reduce(errors, (failed, error) => {
                        if (failed) {
                            return true;
                        }

                        return !_.isEmpty(error) && !_.some(ignoredNpmErrors, ignoredError => _.startsWith(error, `npm ERR! ${ignoredError.npmError}`));
                    }, false);

                    if (failed) {
                        return reject(err);
                    }
                }

                return resolve(stdout);
            })))
            .then(depJson => PromiseHelper.try(() => JSON.parse(depJson)))
            .then((dependencyGraph) => {
                const problems = _.get(dependencyGraph, "problems", []);
                if (!_.isEmpty(problems)) {
                    console.log(`Ignoring ${_.size(problems)} NPM errors:`);
                    _.forEach(problems, (problem) => {
                        console.log(`=> ${problem}`);
                    });
                }

                // (1) Generate dependency composition
                const compositeModules = _.uniq(_.flatMap(stats.stats, (compileStats) => {
                    const externalModules = _.concat(
                        getExternalModules.call(this, compileStats),
                        _.map(packageForceIncludes, whitelistedPackage => ({ external: whitelistedPackage }))
                    );

                    return getProdModules.call(this, externalModules, packagePath, dependencyGraph);
                }));
                removeExcludedModules.call(this, compositeModules, packageForceExcludes, true);

                if (_.isEmpty(compositeModules)) {
                    // The compiled code does not reference any external modules at all
                    console.log("No external modules needed");

                    return Promise.resolve();
                }

                // (1.a) Install all needed modules
                const compositeModulePath = path.join(pathDist);
                const compositePackageJson = path.join(compositeModulePath, "package.json");

                // (1.a.1) Create a package.json
                const compositePackage = {
                    name: "chimera",
                    version: "1.0.0",
                    description: `Packaged externals for chimera`,
                    private: true
                };
                const relPath = path.relative(compositeModulePath, path.dirname(packageJsonPath));
                fse.ensureDir(compositeModulePath);
                addModulesToPackageJson(compositeModules, compositePackage, relPath);
                fse.writeFileSync(compositePackageJson, JSON.stringify(compositePackage, null, 2));

                // (1.a.2) Copy package-lock.json if it exists, to prevent unwanted upgrades
                const packageLockPath = path.join(path.dirname(packageJsonPath), "yarn.lock");

                return fse.pathExists(packageLockPath)
                    .then((exists) => {
                        if (exists) {
                            console.log("Yarn lock found - Using locked versions");
                            try {
                                const compositeModuleLockPath = path.join(path.dirname(compositeModulePath), "yarn.lock");
                                fse.copySync(packageLockPath, compositeModuleLockPath);
                            } catch (err) {
                                console.log(`Warning: Could not read lock file: ${err.message}`);
                            }
                        }

                        return Promise.resolve();
                    })
                    .then(() => {
                        const start = _.now();
                        console.log(`Packing external modules: ${compositeModules.join(", ")}`);

                        return (new Promise((resolve, reject) =>
                            childProcess.exec("yarn", {
                                cwd: compositeModulePath,
                                maxBuffer: 200 * 1024,
                                encoding: "utf8"
                            }, (err, stdout, stderr) => {
                                if (err) {
                                    return reject(err)
                                }

                                return resolve(stdout);
                            })))
                            .then(() => console.log(`Package took [${_.now() - start} ms]`))
                            .then(() => stats.stats);
                    })
                    .then(stats => PromiseHelper.mapSeries(stats, (compileStats) => {
                        const modulePath = compileStats.compilation.compiler.outputPath;

                        // Create package.json
                        const modulePackageJson = path.join(modulePath, "package.json");
                        const modulePackage = {
                            dependencies: {}
                        };
                        const prodModules = getProdModules.call(
                            this,
                            _.concat(
                                getExternalModules.call(this, compileStats),
                                _.map(packageForceIncludes, whitelistedPackage => ({ external: whitelistedPackage }))
                            ), packagePath, dependencyGraph
                        );
                        removeExcludedModules.call(this, prodModules, packageForceExcludes);
                        const relPath = path.relative(modulePath, path.dirname(packageJsonPath));
                        addModulesToPackageJson(prodModules, modulePackage, relPath);
                        fse.writeFileSync(modulePackageJson, JSON.stringify(modulePackage, null, 2));
                    }));
            });
    }
};
