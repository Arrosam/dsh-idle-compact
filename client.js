/**
 * Idle Compact — browser half: the plugin's settings form on the Plugins page
 * (`plugins.bundle.config`, keyed by package name). Values are read and written
 * through the host `configForms` service for the Host row `idle-compact`; only
 * Save writes. Controls are plain elements styled with host theme tokens rather
 * than imported host UI packages, so host UI refactors cannot break this page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-idle-compact',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE_NAME = 'dsh-idle-compact'
    const ENTRY_ID = 'idle-compact'
    const NS = 'idleCompact'
    const FIELDS = ['contextThresholdTokens', 'idleSeconds']
    const DEFAULTS = { contextThresholdTokens: 256000, idleSeconds: 300 }
    const MIN = { contextThresholdTokens: 1, idleSeconds: 1 }

    const en = {
      threshold: 'Context length threshold (tokens)',
      thresholdHint: 'Compact only when the session context is longer than this. Default 256000.',
      idle: 'Idle time (seconds)',
      idleHint: 'Compact after you have not replied for this long. Default 300 (5 minutes).',
      reset: 'Reset to default',
      overridden: 'Custom',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Saved.',
      saveFailed: 'The values were not accepted.',
      invalid: 'Enter a number ≥ {min}.',
      loading: 'Loading…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
    }
    const zh = {
      threshold: '上下文长度阈值（token）',
      thresholdHint: '仅当会话上下文超过此长度时压缩。默认 256000。',
      idle: '空闲时间（秒）',
      idleHint: '你在这段时间内未回复时压缩。默认 300（5 分钟）。',
      reset: '恢复默认',
      overridden: '已自定义',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      saved: '已保存。',
      saveFailed: '这些值未被接受。',
      invalid: '请输入 ≥ {min} 的数字。',
      loading: '加载中…',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
    }

    const css = [
      '.ic-form{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary)}',
      '.ic-row{display:flex;flex-direction:column;gap:6px}',
      '.ic-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500}',
      '.ic-tag{font-size:11px;padding:0 6px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.ic-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ic-line{display:flex;align-items:center;gap:8px}',
      '.ic-input{width:180px;height:30px;padding:0 10px;border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);outline:none}',
      '.ic-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ic-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
      '.ic-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.ic-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.ic-btn{height:30px;padding:0 14px;border-radius:8px;font:inherit;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.ic-btn:disabled{opacity:.4;cursor:not-allowed}',
      // Same fill/foreground token pair as the host primary Button, so the label stays
      // legible in both themes (brand-primary is near-white in dark mode).
      '.ic-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.ic-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.ic-link{background:none;border:none;padding:0;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-brand-primary)}',
      '.ic-actions{display:flex;align-items:center;gap:8px}',
    ].join('')

    const fmt = (v) => (typeof v === 'number' ? String(v) : '')
    /** @returns a number, null for "clear" (empty), or undefined when invalid. */
    function parse(field, text) {
      const trimmed = text.trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      if (!Number.isFinite(n) || n < MIN[field]) return undefined
      return Number.isInteger(n) ? n : undefined
    }

    function makeSettings(form, t) {
      return function IdleCompactSettings(props) {
        const snap = React.useSyncExternalStore(form.subscribe.bind(form), () => form.getSnapshot())
        const [drafts, setDrafts] = React.useState({})
        const [status, setStatus] = React.useState('idle') // idle | saving | saved | failed
        if (props.view === 'summary') return null
        if (snap.status === 'loading') return h('div', { className: 'ic-hint' }, t('loading'))
        if (snap.status === 'unavailable') return h('div', { className: 'ic-hint' }, t('unavailable'))

        const value = snap.value || {}
        const user = snap.user && typeof snap.user === 'object' ? snap.user : {}
        const disabled = !snap.writable || status === 'saving'
        const textOf = (f) => (f in drafts ? drafts[f] : fmt(value[f]))
        const dirty = FIELDS.some((f) => f in drafts && drafts[f] !== fmt(value[f]))
        const invalid = FIELDS.some((f) => f in drafts && parse(f, drafts[f]) === undefined)

        const edit = (f, text) => { setStatus('idle'); setDrafts((d) => ({ ...d, [f]: text })) }
        const reset = (f) => { setStatus('idle'); setDrafts((d) => ({ ...d, [f]: '' })) }
        const discard = () => { setDrafts({}); setStatus('idle') }
        const save = () => {
          const ops = []
          for (const f of FIELDS) {
            if (!(f in drafts)) continue
            const parsed = parse(f, drafts[f])
            if (parsed === null) ops.push({ op: 'unset', path: [f] })
            else ops.push({ op: 'set', path: [f], value: parsed })
          }
          if (ops.length === 0) return
          setStatus('saving')
          form.mutate(ops).then((ok) => {
            setStatus(ok ? 'saved' : 'failed')
            if (ok) setDrafts({})
          }, () => setStatus('failed'))
        }

        const row = (f, label, hint) => {
          const text = textOf(f)
          const bad = f in drafts && parse(f, drafts[f]) === undefined
          const overridden = f in drafts ? drafts[f].trim() !== '' : f in user
          return h('div', { className: 'ic-row', key: f },
            h('label', { className: 'ic-head', htmlFor: 'idle-compact-' + f }, label,
              overridden ? h('span', { className: 'ic-tag' }, t('overridden')) : null),
            h('div', { className: 'ic-hint' }, hint),
            h('div', { className: 'ic-line' },
              h('input', {
                id: 'idle-compact-' + f,
                className: 'ic-input',
                inputMode: 'decimal',
                value: text,
                placeholder: String(DEFAULTS[f]),
                disabled,
                'aria-invalid': bad,
                onChange: (e) => edit(f, e.target.value),
              }),
              overridden ? h('button', { type: 'button', className: 'ic-link', disabled, onClick: () => reset(f) }, t('reset')) : null),
            bad ? h('div', { className: 'ic-err', role: 'alert' }, t('invalid').replace('{min}', String(MIN[f]))) : null)
        }

        return h('div', { className: 'ic-form' },
          // Component-local stylesheet: unmounting the page removes it.
          h('style', null, css),
          !snap.writable ? h('div', { className: 'ic-hint' }, t('readOnly')) : null,
          row('contextThresholdTokens', t('threshold'), t('thresholdHint')),
          row('idleSeconds', t('idle'), t('idleHint')),
          h('div', { className: 'ic-actions' },
            h('button', { type: 'button', className: 'ic-btn ic-btn-primary', disabled: disabled || !dirty || invalid, onClick: save },
              status === 'saving' ? t('saving') : t('save')),
            dirty ? h('button', { type: 'button', className: 'ic-btn', disabled, onClick: discard }, t('discard')) : null,
            status === 'saved' ? h('span', { className: 'ic-ok', role: 'status' }, t('saved')) : null,
            status === 'failed' ? h('span', { className: 'ic-err', role: 'alert' }, t('saveFailed')) : null))
      }
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'idle-compact: dictionaries')
        const Settings = makeSettings(ctx.configForms.get(ENTRY_ID), t)
        ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE_NAME,
          locale: NS,
        }, Settings))), 'idle-compact: settings page')
      },
    }
  },
})
