let { resolve } = require("path");
let { readFile, writeFile, readdir, stat } = require("fs-extra");
let parser = require("@babel/parser");
let traverse = require("@babel/traverse").default;
let generate = require("@babel/generator").default;
let t = require("@babel/types");
let ws = require("ws");
let chalkAnimation = require("chalk-animation");

let rootDir = resolve(process.argv[2] || "");
let port = parseInt(process.env.PORT, 10) || 8123;

async function iterateSourceFiles(root, callback) {
  let fileStat = await stat(root);
  if (fileStat.isDirectory()) {
    let files = await readdir(root);
    return Promise.all(
      files.map(file => iterateSourceFiles(resolve(root, file), callback))
    );
  } else {
    await callback(root);
  }
}

function toAST(code) {
  let ast = parser.parse(code);
  let path;
  traverse(ast, {
    Program: function(_path) {
      path = _path.get("body.0");
      _path.stop();
    }
  });
  return path.node;
}

let incineratorFunctionPrefix = "__incinerator__";

let tagging = tag =>
  toAST(`
  (function ${incineratorFunctionPrefix}tagging() {
    var g = typeof window === "undefined" ? window : global;
    g.__incinerator = g.__incinerator || new WebSocket(\`ws://\${location.hostname}:${port}\`);
    if (g.__incinerator.readyState === 1) {
      g.__incinerator.send(${tag});
    } else {
      g.__incinerator.addEventListener('open', function ${incineratorFunctionPrefix}ws() {
        g.__incinerator.send(${tag});
      });
    }
  }())
`);

function removeTaggings(ast) {
  traverse(ast, {
    CallExpression(path) {
      let callee = path.get("callee");
      if (
        t.isFunctionExpression(callee) &&
        callee.node.id &&
        callee.node.id.name.startsWith(incineratorFunctionPrefix)
      ) {
        path.remove();
      }
    }
  });
}

async function writeAST(path, ast) {
  await writeFile(path, generate(ast).code + "\n");
}

async function confirmIncineration() {
  let stdin;
  await new Promise(resolve => {
    stdin = process.openStdin();
    stdin.addListener("data", data => {
      let str = data.toString();
      if (str.trim().toLowerCase() === "incinerate!") {
        resolve();
      } else if (str.includes("!")) {
        console.log("Well, anyway I'll incinerate!");
        resolve();
      }
    });

    console.log("Waiting for 'incinerate!'");
  });
  stdin.end();
}

function removeUnusedVars(ast) {
  // referencePaths are cached, so create new ast
  ast = parser.parse(generate(ast).code);

  let topLevelDecls = [];
  traverse(ast, {
    VariableDeclarator(path) {
      if (
        t.isIdentifier(path.get("id")) &&
        t.isProgram(path.parentPath.parentPath)
      ) {
        topLevelDecls.push(path);
      }
    }
  });

  let pathsToRemove = [];
  topLevelDecls.forEach(path => {
    let name = path.node.id.name;
    let scope = path.findParent(t.isProgram).scope;
    if (scope.bindings[name].referencePaths.length === 0) {
      pathsToRemove.push(path);
    }
  });

  // do until there's no unused vars
  if (pathsToRemove.length) {
    pathsToRemove.forEach(path => path.remove());
    return removeUnusedVars(ast);
  } else {
    return ast;
  }
}

async function main() {
  let jsFiles = [];
  await iterateSourceFiles(rootDir, async file => {
    let source = await readFile(file, "utf-8");
    let ast = null;
    try {
      ast = parser.parse(source);
    } catch (err) {
      if (err.name !== "SyntaxError") throw err;
    }

    if (ast) {
      jsFiles.push({ file, ast });
    }
  });

  let functionId = 0;
  let functionPathMap = new Map();

  let wss = new ws.Server({ port });

  wss.on("connection", ws => {
    console.log("Connected.");
    ws.on("message", msg => {
      process.stdout.write(".");
      functionPathMap.delete(parseInt(msg, 10));
    });
  });

  await Promise.all(
    jsFiles.map(async ({ file, ast }) => {
      removeTaggings(ast);

      // add new taggings
      traverse(ast, {
        Function(path) {
          if (
            path.node.id &&
            path.node.id.name.startsWith(incineratorFunctionPrefix)
          ) {
            // skip
          } else {
            let id = functionId++;
            functionPathMap.set(id, path);
            let body = path.get("body");
            if (t.isBlock(body)) {
              body.unshiftContainer("body", tagging(id));
            }
          }
        }
      });

      await writeAST(file, ast);
    })
  );

  await confirmIncineration();

  let text = chalkAnimation.rainbow("\nIncinerating!");

  // left paths are unused, let's incinerate them!
  for (let path of functionPathMap.values()) {
    if (t.isFunctionDeclaration(path)) {
      // If it's a declaration, replace with empty declaration
      path.replaceWith(
        t.variableDeclaration("var", [t.variableDeclarator(path.node.id)])
      );
    } else {
      // for the others, just empty its params and body
      path.node.params = [];
      path.node.body = t.blockStatement([]);
    }
  }

  await Promise.all(
    jsFiles.map(async ({ file, ast }) => {
      removeTaggings(ast);
      await writeAST(file, removeUnusedVars(ast));
    })
  );

  wss.close();

  // show text one more sec because it's rainbow
  setTimeout(() => text.stop(), 1000);
}

main();
