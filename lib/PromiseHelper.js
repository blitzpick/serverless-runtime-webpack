exports.fromCallback = function (func) {
  return new Promise((resolve, reject) => {
      const callback = (err, data) => err ? reject(err) : resolve(data)
      
      func.apply(this, [callback])
    });
}