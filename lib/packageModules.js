const PromiseHelper = require("./PromiseHelper");
const _ = require("lodash");
const path = require("path");
const archiver = require("archiver");
const fs = require("fs-extra");
const glob = require("glob");

function setArtifactPath(funcName, func, artifactPath) {
    func.package = {
        artifact: artifactPath
    };
}

function zip(directory, name) {
    console.log(JSON.stringify({ directory, name }));
    const zip = archiver.create("zip");
    // Create artifact in temp path and move it to the package path (if any) later
    const artifactDirectory = path.join(
        directory,
        ".serverless"
    );

    const artifactFilePath = path.join(
        artifactDirectory,
        name
    );
    fs.ensureDir(artifactDirectory);

    console.log(artifactFilePath);

    const output = fs.createWriteStream(artifactFilePath);

    const files = glob.sync("**", {
        cwd: directory,
        dot: true,
        silent: true,
        follow: true
    });

    if (_.isEmpty(files)) {
        const error = new Error("Packaging: No files found");

        return Promise.reject(error);
    }

    output.on("open", () => {
        zip.pipe(output);

        _.forEach(files, (filePath) => {
            const fullPath = path.resolve(
                directory,
                filePath
            );

            const stats = fs.statSync(fullPath);

            if (!stats.isDirectory(fullPath)) {
                zip.append(fs.readFileSync(fullPath), {
                    name: filePath,
                    mode: stats.mode,
                    date: new Date(0) // necessary to get the same hash when zipping the same content
                });
            }
        });

        zip.finalize();
    });

    return new Promise((resolve, reject) => {
        output.on("close", () => resolve(artifactFilePath));
        zip.on("error", err => reject(err));
    });
}

module.exports = {
    packageModules(func, stats, pathDist) {
        console.log("PackageModules");

        return PromiseHelper.mapSeries(stats.stats, (compileStats, index) => {
            const entryFunction = func;
            const filename = `${entryFunction.name}.zip`;
            // console.log(JSON.stringify({ compiler: compileStats.compilation.compiler }));
            const modulePath = compileStats.compilation.compiler.outputPath;

            // const startZip = _.now();

            return zip.call(this, modulePath, filename)
                // .tap(() =>
                //     console.log(`Zip ${_.isEmpty(entryFunction) ? "service" : "function"}: ${modulePath} [${_.now() - startZip} ms]`))
                .then((artifactPath) => {
                    setArtifactPath.call(this, entryFunction.name, func, path.relative(pathDist, artifactPath));

                    return artifactPath;
                });
        })
            .then(() => {
                return null;
            });
    }
};
