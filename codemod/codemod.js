function upper(str) {
  return str[0].toUpperCase() + str.slice(1);
}

module.exports = function plugin({ types: t, template }) {
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

	// 4. Convert state = {…} to useState() (slide 123)
	function findField(node, name) {
		const elem = node.body.body.find(el =>
			t.isClassProperty(el, {
				static: false, computed: false
			})
			&& t.isIdentifier(el.key, { name })
		);
		if (elem) return elem.value;
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
      if (!node.comments) node.comments = [];
      node.comments.push({
        leading: true,
        value: " @warning: Unable to refactor complex state initialization ",
        type: "CommentBlock",
      });
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

  // 4. Convert this.state.count to count (slide 135 - code not shown)
  function rewriteStateRead(path, state) {
    path.traverse({
      MemberExpression(path) {
        if (
          path.get("object").isMemberExpression({ computed: false }) &&
          path.get("object.object").isThisExpression() &&
          path.get("object.property").isIdentifier({ name: "state" })
        ) {
          path.replaceWith(t.cloneNode(state.get(path.node.property.name).get));
        }
      },
    });
  }

  // 4. Convert this.setState to setCount (slide 136 - code not shown)
  function rewriteStateUpdate(path, state) {
    path.traverse({
      CallExpression(path) {
        if (
          path.get("callee").isMemberExpression({ computed: false }) &&
          path.get("callee.object").isThisExpression() &&
          path.get("callee.property").isIdentifier({ name: "setState" }) &&
          path.get("arguments").length === 1
        ) {
          const arg = path.get("arguments.0");

          const updateNodes = [];
          for (const prop of arg.get("properties")) {
            const { name } = prop.node.key;
            updateNodes.push(
              template.ast`
								${state.get(name).set}(${prop.node.value})
							`
            );
          }

          path.replaceWithMultiple(updateNodes);
        }
      },
    });
  }

  // 5. Convert class fields to variables (slide 172)
  function findClassProperties(node) {
    const properties = new Map();
    for (const elem of node.body.body) {
      if (t.isClassProperty(elem, { computed: false, static: false })) {
        const { name } = elem.key;
        if (name === "state") continue;

        properties.set(name, elem.value);
      }
      // BONUS (not in the slides) - Transform class methods
      else if (t.isClassMethod(elem, { computed: false, static: false })) {
        const { name } = elem.key;
        if (
          name === "render" ||
          name === "componentDidMount" ||
          name === "componentDidUnmount"
        ) {
          continue;
        }

        properties.set(
          name,
          t.arrowFunctionExpression(elem.params, elem.body)
        );
      }
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

  // 6. Inject imports for used hooks (slide 203)
  function findReactImport(path) {
    const program = path.findParent((p) => p.isProgram());
    let importPath = program
      .get("body")
      .filter(({ node }) => t.isImportDeclaration(node))
      .find(({ node }) => node.source.value === "react");

    if (importPath) return importPath;

    program.unshiftContainer("body", template.ast`import "react"`);
    return program.get("body.0");
  }

  // BONUS (not in the slides) - Output a "warning" comment when remains a 'this'
  function warnRemaingingThis(path) {
    path.traverse({
      ThisExpression({ node }) {
        if (!node.comments) node.comments = [];
        node.comments.push({
          leading: true,
          value: " @warning: Unhandled 'this' ",
          type: "CommentBlock",
        });
      },
    });
  }

  // BONUS (not in the slides) - Support componentDidMount and componentDidUnmount
  function extractLifecycleHooks(node) {
    const effects = [];
    const componentDidMount = findMethod(node, "componentDidMount");
    if (componentDidMount) {
      effects.push(
        template.ast`
					useEffect(() => { ${componentDidMount} }, []);
        `
      );
    }
    const componentDidUnmount = findMethod(node, "componentDidUnmount");
    if (componentDidUnmount) {
      effects.push(
        template.ast`
					useEffect(() => () => { ${componentDidUnmount} }, []);
        `
      );
    }
    return effects;
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
          for (let { get, set, init } of state.values()) {
            useStateCalls.push(template.ast`
							const [${get}, ${set}] = useState(${init})
						`);
          }

          // 4. Convert this.state.count to count (slide 135 - code not shown)
          rewriteStateRead(path, state);
          // 4. Convert this.setState to setCount (slide 136 - code not shown)
          rewriteStateUpdate(path, state);
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

        // BONUS (not in the slides) - Support componentDidMount and componentDidUnmount
        const useEffectCalls = extractLifecycleHooks(path.node);

        // BONUS (not in the slides) - Output a "warning" comment when remains a 'this'
        warnRemaingingThis(path);

        // 2. Extracting the render() method (slide 104)
        path.replaceWith(template.ast`
					const ${path.node.id} = (props) => {
						${/* (slide 132) */ useStateCalls};
						${/* (slide 179) */ varsDeclarations};
						${/* BONUS (not in the slides) */ useEffectCalls};
						${findMethod(path.node, "render")};
					};
				`);

        // 6. Inject imports for used hooks (slide 217)
        if (useStateCalls.length > 0 && !path.scope.hasBinding("useState")) {
          findReactImport(path).pushContainer(
            "specifiers",
            t.importSpecifier(
              t.identifier("useState"),
              t.identifier("useState")
            )
          );
        }

        // BONUS (not in the slides) - Support componentDidMount and componentDidUnmount
        if (useEffectCalls.length > 0 && !path.scope.hasBinding("useEffect")) {
          findReactImport(path).pushContainer(
            "specifiers",
            t.importSpecifier(
              t.identifier("useEffect"),
              t.identifier("useEffect")
            )
          );
        }
      },
    },
  };
};
