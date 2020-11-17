function upperFirst(str) {
  return str[0].toUpperCase() + str.slice(1);
}

module.exports = function plugin({ types: t, template }) {
  function isReactClass(node) {
    if (!node.superClass) return false;

    return (
      t.isIdentifier(node.superClass, { name: "Component" }) ||
      t.matchesPattern(node.superClass, "React.Component")
    );
  }

  function findMethod(path, name) {
    for (const elem of path.get("body.body")) {
      if (!elem.isClassMethod({ static: false, computed: false })) continue;
      if (!elem.get("key").isIdentifier({ name })) continue;

      return elem.node.body.body;
    }
  }

  function rewritePropsUsage(path) {
    path.traverse({
      MemberExpression(path) {
        if (
          path.get("object").isThisExpression() &&
          !path.node.computed &&
          path.get("property").isIdentifier({ name: "props" })
        ) {
          path.replaceWith(t.identifier("props"));
        }
      },
    });
  }

  function findInitialState(path) {
    for (const elem of path.get("body.body")) {
      if (!elem.isClassProperty({ computed: false, static: false })) continue;
      if (!elem.get("key").isIdentifier({ name: "state" })) continue;

      const obj = elem.get("value");

      if (!obj.isObjectExpression()) {
        throw obj.buildCodeFrameError("Unsupported1");
      }

      const state = new Map();

      for (const prop of obj.get("properties")) {
        if (
          !prop.isObjectProperty({ computed: false }) ||
          !prop.get("key").isIdentifier()
        ) {
          throw obj.buildCodeFrameError("Unsupported2");
        }

        state.set(prop.node.key.name, {
          get: t.identifier(prop.node.key.name),
          set: t.identifier(`set${upperFirst(prop.node.key.name)}`),
          init: prop.node.value,
        });
      }

      return state;
    }
  }

  function rewriteStateRead(path, state, base, known) {
    path.traverse({
      MemberExpression(path) {
        if (base) {
          if (!path.get("object").isIdentifier({ name: base })) return;
          if (!path.get("property").isIdentifier({ name: known })) {
            t.addComment(path.node, "leading", " !!! Unsupported !!! ");
          }
        } else {
          if (!path.get("object").isMemberExpression({ computed: false }))
            return;
          if (!path.get("object.object").isThisExpression()) return;
          if (!path.get("object.property").isIdentifier({ name: "state" }))
            return;
        }

        path.replaceWith(t.cloneNode(state.get(path.node.property.name).get));
      },
    });
  }

  function rewriteSetStateObject(path, replacePath, state) {
    const updateNodes = [];
    for (const prop of path.get("properties")) {
      const { name } = prop.node.key;
      updateNodes.push(template.statement.ast`
          ${state.get(name).set}(${prop.node.value})
        `);
    }

    replacePath.replaceWithMultiple(updateNodes);
  }

  function rewriteSetStateCallback(path, replacePath, state) {
    let returnValue = path.get("body");
    if (returnValue.isBlockStatement()) {
      returnValue = path.get(
        `body.body.${path.node.body.body.length - 1}.argument`
      );
    }

    if (!returnValue.isObjectExpression()) return; // Unsupported
    if (returnValue.get("properties").length !== 1) return; // Unsupported

    const { name } = returnValue.node.properties[0].key;
    const { value } = returnValue.node.properties[0];

    if (path.get("params").length > 0)
      rewriteStateRead(path, state, path.node.params[0].name, name);

    replacePath.replaceWith(template.statement.ast`
        ${state.get(name).set}(${state.get(name).get} => ${value});
      `);
  }

  function rewriteStateUpdate(path, state) {
    path.traverse({
      CallExpression(path) {
        if (!path.get("callee").isMemberExpression({ computed: false })) return;
        if (!path.get("callee.object").isThisExpression()) return;
        if (!path.get("callee.property").isIdentifier({ name: "setState" }))
          return;
        if (path.get("arguments").length !== 1) return;

        const arg = path.get("arguments.0");
        if (arg.isObjectExpression()) {
          rewriteSetStateObject(arg, path, state);
        } else if (arg.isFunction()) {
          rewriteSetStateCallback(arg, path, state);
        }
      },
    });
  }

  function findClassProperties(path) {
    const properties = new Map();

    for (const elem of path.get("body.body")) {
      if (elem.isClassProperty({ computed: false, static: false })) {
        const { name } = elem.node.key;
        if (name === "state") continue;

        properties.set(name, elem.node.value);
      } else if (elem.isClassMethod({ computed: false, static: false, kind: "method" })) {
        const { name } = elem.node.key;
        if (name === "render" || name.startsWith("component")) continue;

        properties.set(name, t.arrowFunctionExpression(elem.node.params, elem.node.body));
      }
    }

    return properties;
  }

  function rewriteVarsUsage(path, props) {
    path.traverse({
      MemberExpression(path) {
        if (!path.get("object").isThisExpression()) return;
        if (path.node.computed) return;

        const { name } = path.node.property;
        if (!props.has(name)) return;

        path.replaceWith(t.identifier(name));
      },
    });
  }

  function extractLifecycleHooks(path) {
    const effects = [];
    const componentDidMount = findMethod(path, "componentDidMount");
    if (componentDidMount) {
      effects.push(template.statement.ast`
          useEffect(() => { ${componentDidMount} }, []);
        `);
    }
    const componentDidUnmount = findMethod(path, "componentDidUnmount");
    if (componentDidUnmount) {
      effects.push(template.statement.ast`
          useEffect(() => () => { ${componentDidUnmount} }, []);
        `);
    }
    return effects;
  }

  function warnRemaingingThis(path) {
    path.traverse({
      ThisExpression({ node }) {
        (node.comments ?? (node.comments = [])).push({
          leading: true,
          trailing: false,
          value: " @warning: Unhandled 'this' ",
          type: "CommentBlock"
        });
      }
    })
  }

  return {
    visitor: {
      ClassDeclaration(path) {
        const { node } = path;

        if (!isReactClass(node)) return;

        const componentId = path.node.id;

        rewritePropsUsage(path);

        const state = findInitialState(path);
        const useStateCalls = [];
        if (state) {
          for (let { get, set, init } of state.values()) {
            if (!t.isImmutable(init))
              init = template.expression.ast`() => ${init}`;
            useStateCalls.push(
              template.statement.ast`
                  const [${get}, ${set}] = useState(${init})`
            );
          }
          rewriteStateRead(path, state);
          rewriteStateUpdate(path, state);

          if (!path.scope.hasBinding("useState")) {
            path.find(p => p.isProgram()).unshiftContainer("body", template.ast`
              import { useState } from "react";
            `);
          }
        }

        const vars = findClassProperties(path);
        const varsDeclarations = [];
        for (const [name, value] of vars) {
          varsDeclarations.push(template.statement.ast`
              const ${t.identifier(name)} = ${value};
            `);
        }
        rewriteVarsUsage(path, vars);

        const effects = extractLifecycleHooks(path);
        if (effects.length) {
          if (!path.scope.hasBinding("useEffect")) {
            path.find(p => p.isProgram()).unshiftContainer("body", template.ast`
              import { useEffect } from "react";
            `);
          }
        }

        path.replaceWith(template.statement.ast`
            const ${componentId} = (props) => {
              ${useStateCalls};
              ${varsDeclarations};
              ${effects};

              ${findMethod(path, "render")};
            };
          `);

        warnRemaingingThis(path);
      },
    },
  };
};
