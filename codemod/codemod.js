module.exports = function plugin() {
  // 1. Detecting React class components (slide 93)
  function isReactComponent(node) {
    return t.matchesPattern(node.superClass, "React.Component");
  }

  // 2. Extracting the render() method (slide 103)
  function findMethod(node, name) {
    const elem = node.body.body.find(
      (el) =>
        t.isClassMethod(el, {
          static: false,
          computed: false,
        }) && t.isIdentifier(el.key, { name })
    );
    if (elem) return elem.body.body;
  }

  // 3. Rewriting this.props usage (slide 115)
  function rewritePropsUsage(path) {
    path.traverse({
      MemberExpression(path) {
        const { node } = path;
        if (
          !node.computed &&
          t.isThisExpression(node.object) &&
          t.isIdentifier(node.property, { name: "props" })
        ) {
          path.replaceWith(t.identifier("props"));
        }
      },
    });
  }

  // 4. Convert state = {…} to useState() (slide 128)
  function findInitialState(node) {
    const stateNode = findField(node, "state");
    if (!stateNode) return;

    // 🔍 Complex state initialization (slide 147)
    if (!t.isObjectExpression(stateNode)) {
      t.addComment(
        stateNode.node,
        "leading",
        " @warning: Unable to refactor complex state initialization "
      );
      return;
    }

    const state = new Map();
    for (const prop of stateNode.properties) {
      state.set(prop.key.name, {
        get: t.identifier(prop.key.name),
        set: t.identifier(`set${upper(prop.key.name)}`),
        init: prop.value,
      });
    }
    return state;
  }

  // 5. Convert class fields to variables (slide 172)
  function findClassProperties(node) {
    const properties = new Map();
    for (const elem of node.body.body) {
      if (
        !t.isClassProperty(elem, {
          computed: false,
          static: false,
        })
      ) {
        continue;
      }

      if (elem.key.name === "state") continue;

      properties.set(elem.key.name, elem.value);
    }
    return properties;
  }

  // 5. Convert class fields usage to variables (slide 188)
  function rewriteVarsUsage(path, props) {
    path.traverse({
      MemberExpression(path) {
        const { node } = path;
        if (!t.isThisExpression(node.object)) return;
        if (node.computed) return;

        const { name } = node.property;
        if (!props.has(name)) return;

        path.replaceWith(t.identifier(name));
      },
    });
  }

  // 6. Inject imports for used hooks (slide 204)
  function findReactImport(path) {
    const program = path.findParent((p) => p.isProgram());
    let importPath = program
      .get("body")
      .find(({ node }) => t.isImportDeclaration(node))
      .find(({ node }) => node.source.value === "react");

    if (importPath) return importPath;

    program.unshiftContainer("body", template.ast`import "react"`);
    return program.get("body.0");
  }

  return {
    visitor: {
      ClassDeclaration(path) {
        // 1. Detecting React class components (slide 92)
        if (!isReactComponent(path.node)) {
          return;
        }

        // 3. Rewriting this.props usage (slide 119)
        rewritePropsUsage(path);

        // 4. Convert state = {…} to useState() (slide 132)
        const state = findInitialState(path.node);
        const useStateCalls = [];
        if (state) {
          for (let { get, set, init } of state.values())
            useStateCalls.push(template.ast`
							const [${get}, ${set}] = useState(${init})
						`);
        }

        // 5. Convert class fields to variables (slide 179)
        const vars = findClassProperties(path.node);
        const varsDeclarations = [];
        for (const [name, init] of vars)
          varsDeclarations.push(template.ast`
						const ${t.identifier(name)} = ${init};
					`);

        // 5. Convert class fields to variables (slide 188)
        rewriteVarsUsage(path, vars);

        // 2. Extracting the render() method (slide 104)
        path.replaceWith(template.ast`
					const ${path.node.id} = (props) => {
						${/* (slide 132) */ useStateCalls};
						${/* (slide 179) */ varsDeclarations};
						${findMethod(path.node, "render")};
					};
				`);

				// 6. Inject imports for used hooks (slide 218)
        if (useStateCalls.length > 0 && !path.scope.hasBinding("useState")) {
          findReactImport(path).pushContainer(
            "specifiers",
            t.importSpecifier(
              t.identifier("useState"),
              t.identifier("useState")
            )
          );
        }
      },
    },
  };
};
