# Babel: A refactoring tool

HolyJS Moscow 2020

## [slides](https://github.com/nicolo-ribaudo/conf-holyjs-moscow-2020/blob/main/Babel_%20A%20refactoring%20tool.pdf)

## [codemod](https://github.com/nicolo-ribaudo/conf-holyjs-moscow-2020/tree/main/codemod)

## [demo app](https://github.com/nicolo-ribaudo/conf-holyjs-moscow-2020/tree/main/todomvc)

---

To run the demo:

```
cd todomvc
npm ci # Install the dependencies specified in the lockfile
npm run build
npm run start
```

To run the codemod on the demo:

```
cd codemod
npm ci # Install the dependencies specified in the lockfile
cd ..

node codemod/run.js todomvc/js/*.{ts,tsx}
```
