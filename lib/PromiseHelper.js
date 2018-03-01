exports.fromCallback = function (func) {
    return new Promise((resolve, reject) => {
        const callback = (err, data) => (err ? reject(err) : resolve(data));

        func.apply(this, [callback]);
    });
};

exports.try = function (func) {
    return new Promise(((resolve, reject) => {
        resolve(func());
    }));
};

exports.mapSeries = function (array, iterator, thisArg) {
    const length = array.length;
    let current = Promise.resolve();
    const results = new Array(length);
    const cb = arguments.length > 2 ? iterator.bind(thisArg) : iterator;
    for (let i = 0; i < length; ++i) {
        current = results[i] = current.then(((i) => {
            return cb(array[i], i, array);
        }).bind(undefined, i));
    }

    return Promise.all(results);
};