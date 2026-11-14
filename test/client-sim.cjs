const fs = require('node:fs')
let captured = null
global.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
const file = require('node:path').join(__dirname, '..', 'lib', 'client.js')
new Function('window', fs.readFileSync(file, 'utf8'))(global.window)
if (!captured) { console.error('bundle did not call __ModuleLoader__.load'); process.exit(1) }
const React = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const out = captured.factory((n) => { if (n === 'react') return React; throw new Error('unexpected require ' + n) })
console.log('id:', captured.id)
console.log('exports:', Object.keys(out).join(','), '| inject:', JSON.stringify(out.inject))
const registered = []
out.apply({ slots: { inject: (n, fn) => fn(), register: (meta, comp) => { registered.push({ meta, comp }); return () => {} } } })
for (const r of registered) console.log('registered:', r.meta.name, 'id=' + r.meta.id, 'order=' + r.meta.order, 'label=' + (typeof r.meta.label === 'function' ? r.meta.label() : r.meta.label), 'comp=' + typeof r.comp)
const rendered = registered[0].comp({ close: () => {} })
console.log('panel renders without throwing; node type:', typeof rendered.type)
