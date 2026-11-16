const postcss = require("postcss");
const postcssImport = require("postcss-import");

// Only the design entry uses this loader. Its imported styles are siblings, so their asset URLs
// remain relative to the same directory when inlined. Keep layers for theme/extension precedence.
module.exports = function designCssImports(source, inputMap) {
  const callback = this.async();
  postcss([postcssImport()])
    .process(source, {
      from: this.resourcePath,
      to: this.resourcePath,
      map: this.sourceMap ? { prev: inputMap, inline: false, annotation: false } : false,
    })
    .then((result) => {
      for (const message of result.messages) {
        if (message.type === "dependency") this.addDependency(message.file);
      }
      for (const warning of result.warnings()) this.emitWarning(new Error(warning.toString()));
      callback(null, result.css, result.map?.toJSON());
    }, callback);
};
