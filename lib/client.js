/**
 * dsh-vpn-panel — client half.
 *
 * Registers a "VPN" entry inside Settings (slot `settings.section`) that talks
 * to the host routes served by ./src/index.js under /dsh-vpn/*.
 *
 * Hand-written bundle: window.__ModuleLoader__ supplies only `react`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vpn-panel',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    /* ── styling helpers ───────────────────────────────────────────── */

    const C = {
      text: 'var(--dsh-text-primary, #e8e8ea)',
      dim: 'var(--dsh-text-secondary, #9a9aa2)',
      faint: 'var(--dsh-text-tertiary, #6f6f78)',
      line: 'var(--dsh-border, rgba(255,255,255,0.10))',
      card: 'var(--dsh-surface-raised, rgba(255,255,255,0.04))',
      field: 'var(--dsh-surface-sunken, rgba(0,0,0,0.22))',
      accent: 'var(--dsh-accent, #5b9dff)',
      ok: '#43c584',
      warn: '#e8b44a',
      bad: '#e5646b',
    }

    const s = {
      root: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 28px', color: C.text, fontSize: 13, lineHeight: 1.55 },
      card: { border: '1px solid ' + C.line, borderRadius: 12, background: C.card, padding: 14 },
      row: { display: 'flex', alignItems: 'center', gap: 10 },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      label: { color: C.dim, fontSize: 12 },
      value: { color: C.text, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
      h1: { fontSize: 16, fontWeight: 650, margin: 0, letterSpacing: 0.2 },
      h2: { fontSize: 12, fontWeight: 650, margin: 0, color: C.dim, letterSpacing: 0.4, textTransform: 'uppercase' },
      btn: {
        appearance: 'none',
        border: '1px solid ' + C.line,
        background: 'rgba(255,255,255,0.06)',
        color: C.text,
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12,
        cursor: 'pointer',
        transition: 'background .15s ease, border-color .15s ease',
        fontFamily: 'inherit',
      },
      btnGhost: { appearance: 'none', border: '1px solid transparent', background: 'transparent', color: C.dim, borderRadius: 8, padding: '5px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        border: '1px solid ' + C.line,
        background: C.field,
        color: C.text,
        borderRadius: 8,
        padding: '6px 9px',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        outline: 'none',
      },
      pill: (color) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        borderRadius: 999,
        border: '1px solid ' + color + '55',
        background: color + '18',
        color,
        fontSize: 11,
        fontWeight: 600,
      }),
      dot: (color) => ({ width: 7, height: 7, borderRadius: 999, background: color, boxShadow: '0 0 8px ' + color + '99' }),
      log: {
        margin: 0,
        maxHeight: 220,
        overflow: 'auto',
        padding: 10,
        borderRadius: 8,
        background: C.field,
        border: '1px solid ' + C.line,
        fontSize: 11,
        lineHeight: 1.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        color: C.dim,
      },
      list: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflow: 'auto', marginTop: 8 },
      item: (active) => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '6px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        background: active ? 'rgba(91,157,255,0.14)' : 'transparent',
        border: '1px solid ' + (active ? 'rgba(91,157,255,0.35)' : 'transparent'),
      }),
    }

    /* ── api ───────────────────────────────────────────────────────── */

    async function api(path, method, body) {
      const init = { method: method || 'GET', headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const res = await fetch(path, init)
      let json = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      if (!json) throw new Error('HTTP ' + res.status)
      return json
    }

    const fmtKbps = (n) => (typeof n === 'number' ? n >= 1024 ? (n / 1024).toFixed(2) + ' MB/s' : n + ' KB/s' : '—')

    /* ── small components ──────────────────────────────────────────── */

    function Switch(props) {
      const { on, disabled, onChange, labels } = props
      return h(
        'button',
        {
          type: 'button',
          disabled,
          onClick: onChange,
          title: on ? labels[1] : labels[0],
          style: {
            appearance: 'none',
            border: '1px solid ' + (on ? C.ok + '88' : C.line),
            background: on ? C.ok + '22' : 'rgba(255,255,255,0.05)',
            borderRadius: 999,
            width: 54,
            height: 28,
            padding: 2,
            cursor: disabled ? 'default' : 'pointer',
            opacity: disabled ? 0.55 : 1,
            transition: 'background .18s ease, border-color .18s ease',
            display: 'flex',
            alignItems: 'center',
          },
        },
        h('span', {
          style: {
            display: 'block',
            width: 22,
            height: 22,
            borderRadius: 999,
            background: on ? C.ok : '#7a7a84',
            transform: on ? 'translateX(26px)' : 'translateX(0px)',
            transition: 'transform .18s cubic-bezier(.4,.9,.3,1), background .18s ease',
          },
        }),
      )
    }

    function Row(props) {
      return h('div', { style: s.spread }, h('span', { style: s.label }, props.k), h('span', { style: s.value }, props.v))
    }

    /* ── main panel ────────────────────────────────────────────────── */

    function VpnPanel() {
      const [status, setStatus] = useState(null)
      const [nodes, setNodes] = useState(null)
      const [settings, setSettings] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [speed, setSpeed] = useState(null)
      const [delays, setDelays] = useState({})
      const [filter, setFilter] = useState('')
      const [showLog, setShowLog] = useState(false)
      const [draft, setDraft] = useState(null)
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const pullStatus = useCallback(async () => {
        try {
          const st = await api('/dsh-vpn/status.json')
          if (alive.current) setStatus(st)
        } catch {}
      }, [])

      const pullNodes = useCallback(async () => {
        try {
          const nd = await api('/dsh-vpn/nodes.json')
          if (alive.current) setNodes(nd.ok ? nd : null)
        } catch {
          if (alive.current) setNodes(null)
        }
      }, [])

      useEffect(() => {
        pullStatus()
        api('/dsh-vpn/settings.json')
          .then((r) => {
            if (!alive.current) return
            setSettings(r.settings)
            setDraft(r.settings)
          })
          .catch(() => {})
      }, [pullStatus])

      useEffect(() => {
        const timer = setInterval(() => {
          if (!alive.current) return
          if (!busy) pullStatus()
        }, 5000)
        return () => clearInterval(timer)
      }, [busy, pullStatus])

      useEffect(() => {
        if (status && status.running) pullNodes()
        else setNodes(null)
      }, [status && status.running, pullNodes])

      const toast = (kind, text) => {
        setNotice({ kind, text })
        setTimeout(() => {
          if (alive.current) setNotice((n) => (n && n.text === text ? null : n))
        }, 6000)
      }

      const toggle = async () => {
        const want = !(status && status.running)
        setBusy(want ? '开启中…' : '关闭中…')
        setNotice(null)
        try {
          const res = await api('/dsh-vpn/power.json', 'POST', { on: want })
          if (alive.current) {
            if (res.status) setStatus(res.status)
            if (res.ok) toast('ok', want ? 'VPN 已开启，系统代理已接管' : 'VPN 已关闭，系统代理已还原')
            else toast('bad', (res.error || res.log || '操作失败').slice(0, 300))
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
          pullStatus()
        }
      }

      const selectNode = async (nodeName) => {
        setBusy('切换节点…')
        try {
          const res = await api('/dsh-vpn/select.json', 'POST', { name: nodeName })
          if (alive.current) {
            if (res.ok) toast('ok', '已切换到 ' + nodeName)
            else toast('bad', res.error || '切换失败')
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
          pullStatus()
        }
      }

      const testDelay = async () => {
        const list = (nodes && nodes.list) || []
        if (!list.length) return
        setBusy('测延迟…')
        try {
          const sample = list.slice(0, 40)
          const res = await api('/dsh-vpn/delay.json?names=' + encodeURIComponent(sample.join(',')))
          if (res.ok && alive.current) {
            const map = {}
            for (const r of res.results) map[r.name] = r.delay
            setDelays((d) => Object.assign({}, d, map))
            const aliveCount = res.results.filter((r) => r.delay !== null).length
            toast('ok', `测速完成：${aliveCount}/${res.results.length} 个节点可用`)
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const testSpeed = async () => {
        setBusy('测速中…')
        setSpeed(null)
        try {
          const res = await api('/dsh-vpn/speed.json')
          if (alive.current) {
            setSpeed(res)
            if (res.ok) toast('ok', '下载速度 ' + fmtKbps(res.kbps))
            else toast('bad', res.error || '测速失败')
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const refreshSubs = async () => {
        setBusy('更新订阅…')
        try {
          const res = await api('/dsh-vpn/refresh.json', 'POST', {})
          if (alive.current) {
            if (res.status) setStatus(res.status)
            toast(res.ok ? 'ok' : 'bad', res.ok ? '订阅已更新，节点列表已重建' : (res.error || '更新失败'))
            if (res.log) setShowLog(true)
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
          pullNodes()
        }
      }

      const saveSettings = async () => {
        if (!draft) return
        setBusy('保存设置…')
        try {
          const res = await api('/dsh-vpn/settings/save.json', 'POST', draft)
          if (alive.current) {
            if (res.ok) {
              setSettings(res.settings)
              setDraft(res.settings)
              if (res.status) setStatus(res.status)
              toast('ok', '设置已保存')
            } else toast('bad', res.error || '保存失败')
          }
        } catch (err) {
          if (alive.current) toast('bad', String(err.message || err))
        } finally {
          if (alive.current) setBusy('')
        }
      }

      const running = !!(status && status.running)
      const badge = busy
        ? { color: C.warn, text: busy }
        : running
          ? { color: C.ok, text: status && status.systemProxy ? '已开启 · 全局代理' : '已开启 · 未改系统代理' }
          : { color: C.faint, text: '未开启' }

      const visibleList = useMemo(() => {
        const list = (nodes && nodes.list) || []
        const q = filter.trim().toLowerCase()
        if (!q) return list
        return list.filter((n) => String(n).toLowerCase().includes(q))
      }, [nodes, filter])

      return h(
        'div',
        { style: s.root },

        /* header */
        h(
          'div',
          { style: s.spread },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
            h('h1', { style: s.h1 }, 'VPN'),
            h('span', { style: { ...s.label, fontSize: 11 } }, '免费节点 · Mihomo 内核 · 本地代理'),
          ),
          h('div', { style: s.row }, h('span', { style: s.pill(badge.color) }, h('span', { style: s.dot(badge.color) }), badge.text)),
        ),

        /* master switch */
        h(
          'div',
          { style: { ...s.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { fontWeight: 600 } }, running ? '代理正在运行' : '代理处于关闭状态'),
            h(
              'span',
              { style: { ...s.label, fontSize: 11 } },
              running
                ? 'HTTP/SOCKS 入口 127.0.0.1:' + (status.proxyPort || '—') + ' · 规则分流：国内直连，国外走代理'
                : '打开后自动选择最快节点，并接管系统代理',
            ),
          ),
          h(Switch, { on: running, disabled: !!busy, onChange: toggle, labels: ['打开 VPN', '关闭 VPN'] }),
        ),

        /* notice */
        notice &&
          h(
            'div',
            {
              style: {
                border: '1px solid ' + (notice.kind === 'ok' ? C.ok : C.bad) + '55',
                background: (notice.kind === 'ok' ? C.ok : C.bad) + '14',
                color: notice.kind === 'ok' ? C.ok : C.bad,
                borderRadius: 9,
                padding: '8px 11px',
                fontSize: 12,
              },
            },
            notice.text,
          ),

        /* status */
        h(
          'div',
          { style: s.card },
          h('h2', { style: s.h2 }, '状态'),
          h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 } },
            h(Row, { k: '内核进程', v: running ? '运行中 (127.0.0.1:' + status.proxyPort + ')' : '未运行' }),
            h(Row, { k: '系统代理', v: status && status.systemProxy ? (status.proxyServer || '已开启') : '未接管' }),
            h(Row, { k: '当前节点', v: (status && status.node) || '—' }),
            h(Row, { k: '可选节点', v: status && status.nodeCount ? status.nodeCount + ' 个' : '—' }),
            speed && h(Row, { k: '下载测速', v: speed.ok ? fmtKbps(speed.kbps) + ' · ' + speed.seconds + 's' : '失败：' + (speed.error || '') }),
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            h('button', { type: 'button', style: s.btn, disabled: !!busy || !running, onClick: testSpeed }, '测下载速度'),
            h('button', { type: 'button', style: s.btn, disabled: !!busy || !running, onClick: testDelay }, '测节点延迟'),
            h('button', { type: 'button', style: s.btn, disabled: !!busy, onClick: refreshSubs }, '更新订阅节点'),
            h('button', { type: 'button', style: s.btn, disabled: !!busy, onClick: () => pullStatus() }, '刷新状态'),
          ),
        ),

        /* nodes */
        running &&
          h(
            'div',
            { style: s.card },
            h(
              'div',
              { style: s.spread },
              h('h2', { style: s.h2 }, '节点'),
              h('span', { style: { ...s.label, fontSize: 11 } }, ((nodes && nodes.list) || []).length + ' 个可选'),
            ),
            h('input', {
              style: { ...s.input, marginTop: 10, fontFamily: 'inherit' },
              placeholder: '筛选节点名称…',
              value: filter,
              onChange: (e) => setFilter(e.target.value),
            }),
            h(
              'div',
              { style: s.list },
              visibleList.slice(0, 200).map((nodeName) =>
                h(
                  'div',
                  {
                    key: nodeName,
                    style: s.item(nodes && nodes.now === nodeName),
                    onClick: () => !busy && selectNode(nodeName),
                    title: '点击设为当前节点',
                  },
                  h('span', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, nodeName),
                  h(
                    'span',
                    { style: { ...s.label, fontSize: 11, flex: 'none' } },
                    delays[nodeName] === null ? '超时' : delays[nodeName] ? delays[nodeName] + ' ms' : nodes && nodes.now === nodeName ? '使用中' : '',
                  ),
                ),
              ),
              !visibleList.length && h('div', { style: { ...s.label, padding: 10 } }, nodes ? '没有匹配的节点' : '节点列表加载中…'),
            ),
          ),

        /* settings */
        draft &&
          h(
            'div',
            { style: s.card },
            h('h2', { style: s.h2 }, '设置'),
            h(
              'div',
              { style: { marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                h('span', { style: s.label }, '本地代理端口'),
                h('input', {
                  style: s.input,
                  type: 'number',
                  value: draft.proxyPort,
                  onChange: (e) => setDraft({ ...draft, proxyPort: Number(e.target.value) || 0 }),
                }),
              ),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                h('span', { style: s.label }, '控制器端口'),
                h('input', {
                  style: s.input,
                  type: 'number',
                  value: draft.controllerPort,
                  onChange: (e) => setDraft({ ...draft, controllerPort: Number(e.target.value) || 0 }),
                }),
              ),
            ),
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 } },
              h('span', { style: s.label }, '脚本目录'),
              h('input', { style: s.input, value: draft.scriptsDir, onChange: (e) => setDraft({ ...draft, scriptsDir: e.target.value }) }),
            ),
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 } },
              h('span', { style: s.label }, '测速地址 (http)'),
              h('input', { style: s.input, value: draft.testUrl, onChange: (e) => setDraft({ ...draft, testUrl: e.target.value }) }),
            ),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: !!draft.autoStart,
                onChange: (e) => setDraft({ ...draft, autoStart: e.target.checked }),
              }),
              h('span', { style: { fontSize: 12 } }, '开机自动开启 VPN'),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 12 } },
              h('button', { type: 'button', style: { ...s.btn, borderColor: C.accent + '66', background: C.accent + '22' }, disabled: !!busy, onClick: saveSettings }, '保存设置'),
              h('button', { type: 'button', style: s.btnGhost, onClick: () => setDraft(settings) }, '还原'),
            ),
          ),

        /* log */
        status &&
          (status.lastLog || status.lastError) &&
          h(
            'div',
            { style: s.card },
            h(
              'div',
              { style: s.spread },
              h('h2', { style: s.h2 }, '最近日志'),
              h('button', { type: 'button', style: s.btnGhost, onClick: () => setShowLog(!showLog) }, showLog ? '收起' : '展开'),
            ),
            showLog && h('pre', { style: { ...s.log, marginTop: 10 } }, (status.lastLog || '') + (status.lastError ? '\n[error]\n' + status.lastError : '')),
          ),

        h(
          'div',
          { style: { ...s.label, fontSize: 11, display: 'flex', justifyContent: 'space-between' } },
          h('span', null, '内核：Mihomo · 配置由订阅自动生成'),
          status && status.lastActionAt ? h('span', null, '上次操作 ' + new Date(status.lastActionAt).toLocaleTimeString()) : null,
        ),
      )
    }

    /* ── plugin contract ───────────────────────────────────────────── */

    module.exports = {
      name: 'vpn-panel',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'vpn',
              order: 60,
              label: () => 'VPN',
            },
            VpnPanel,
          ),
        )
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            {
              name: 'settings.section.icon',
              id: 'vpn',
            },
            () =>
              h(
                'svg',
                { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
                h('path', { d: 'M12 3l7 3v6c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6l7-3z' }),
                h('path', { d: 'M9.2 12.2l2 2 3.6-3.9' }),
              ),
          ),
        )
      },
    }

    return module.exports
  },
})
