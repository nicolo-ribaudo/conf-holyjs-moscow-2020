const codemod = require("./codemod");
const babel = require("@babel/core");
const parser = require("@babel/parser");
const recast = require("recast");
const path = require("path");
const fs = require("fs");

const files = process.argv.slice(2);

files.forEach(transformFile);

function transformFile(filename) {
  const file = path.join(process.cwd(), filename);

  const input = fs.readFileSync(file, "utf-8");
  const output = transform(input, filename, codemod);
  fs.writeFileSync(file, output);
}

function transform(source, filename, codemod) {
  const ast = recast.parse(source, {
	parser: {
	  parse(source) {
		return parser.parse(source, {
		  filename,
		  tokens: true,
		  sourceType: "module",
		  plugins: ["typescript", "classProperties", "jsx"],
		});
	  },
	},
  });

  babel.transformFromAstSync(ast, source, {
	code: false,
	cloneInputAst: false,
	configFile: false,
	plugins: [codemod]
  });

  return recast.print(ast).code;
}
