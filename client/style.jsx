// 风格：核心风格 + 内容类型 + 写作规则，另有「账号名单」标签页。
import React from 'react'
import { dispatchOps, extractStyle, importVoice, saveCondensed, toast, useDesk } from './desk.js'
import { cardToForm, formToCard, t } from './util.js'
import { Empty, Icon, Segmented } from './ui.jsx'
import { WatchView } from './watch.jsx'

const CONDENSED_MAX = 2000
const CARD_FIELDS = [
  { key: 'name', label: '名称', line: true },
  { key: 'summary', label: '一句话概括' },
  { key: 'tone', label: '语气' },
  { key: 'sentences', label: '句子' },
  { key: 'opening', label: '开头' },
  { key: 'structure', label: '结构' },
  { key: 'words', label: '常用词（一行一个）', list: true },
  { key: 'avoid', label: '避免（一行一个）', list: true },
  { key: 'samples', label: '例句（一行一条）', list: true },
]

/** 风格卡编辑器：核心风格和内容类型共用；表单值全是字符串，列表字段一行一项。 */
function CardEditor({ form, onChange, hideName = false }) {
  return (
    <div className="md-form md-style-editor">
      {CARD_FIELDS.filter(field => !(hideName && field.key === 'name')).map(field => (
        <label className="md-field" key={field.key}>
          <span>{t(field.label)}</span>
          {field.line ? (
            <input value={form[field.key]} onChange={event => onChange({ ...form, [field.key]: event.target.value })} />
          ) : (
            <textarea rows={field.list ? 4 : 2} value={form[field.key]} onChange={event => onChange({ ...form, [field.key]: event.target.value })} />
          )}
        </label>
      ))}
    </div>
  )
}

/** 引入 skill：填目录路径或粘贴全文，二选一。 */
function SkillImport({ layer, onDone, onCancel }) {
  const [path, setPath] = React.useState('')
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const ready = Boolean(path.trim() || text.trim())
  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    const ok = await importVoice({ layer, ...(path.trim() ? { path: path.trim() } : { text: text.trim() }) })
    setBusy(false)
    if (ok) { toast(t('已引入')); onDone() }
  }
  return (
    <form className="md-form md-style-import" onSubmit={submit}>
      <label className="md-field">
        <span>{t('skill 目录路径')}</span>
        <input placeholder="~/.claude/skills/khazix-writer" value={path} disabled={busy} onChange={event => setPath(event.target.value)} />
        <small>{t('路径必须在你的用户目录之内。')}</small>
      </label>
      <label className="md-field">
        <span>{t('或者粘贴 skill 全文')}</span>
        <textarea rows={6} value={text} disabled={busy || Boolean(path.trim())} onChange={event => setText(event.target.value)} />
      </label>
      <div className="md-form-foot">
        <span style={{ flex: 1 }} />
        <button type="button" className="md-btn" disabled={busy} onClick={onCancel}>{t('取消')}</button>
        <button type="submit" className="md-btn is-primary" disabled={!ready || busy}>{busy ? t('引入中…') : t('引入')}</button>
      </div>
    </form>
  )
}

/** 来源是 skill 时的精简版编辑。 */
function CondensedEditor({ layer, row }) {
  const [value, setValue] = React.useState(row.condensed ?? '')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { setValue(row.condensed ?? '') }, [row.condensed, row.updatedAt])
  const over = value.length > CONDENSED_MAX
  const save = async () => {
    setBusy(true)
    const ok = await saveCondensed({ layer, condensed: value })
    setBusy(false)
    if (ok) toast(t('精简版已保存'))
  }
  return (
    <div className="md-style-condensed">
      {row.condensedBy === 'fallback' ? <p className="md-style-warn" role="status">{t('精简版是直接截取的原文，建议手动改一下')}</p> : null}
      <label className="md-field">
        <span>{t('精简版')}</span>
        <textarea rows={8} value={value} disabled={busy} onChange={event => setValue(event.target.value)} />
        <small className={over ? 'is-over' : ''}>{t('{n} / {max} 字', { n: value.length, max: CONDENSED_MAX })}　{t('短推文用这份精简版，长文用完整原文')}</small>
      </label>
      <button type="button" className="md-btn is-small" disabled={busy || over || value === (row.condensed ?? '')} onClick={save}>{t('保存精简版')}</button>
    </div>
  )
}

const sourceLabel = row => (row.source === 'skill' ? t('来源：skill') : t('来源：风格卡'))

function CoreBlock() {
  const core = useDesk(s => s.state.voice?.core)
  // null | 'skill' | 'extract' | 'manual' | 'edit'
  const [mode, setMode] = React.useState(null)
  const [form, setForm] = React.useState(() => cardToForm(null))
  const [source, setSource] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const open = (next, card = null) => { setForm(cardToForm(card)); setSource(''); setMode(next) }
  const save = async () => {
    const card = formToCard(form)
    if (!card.name) { toast(t('先给风格起个名字'), { error: true }); return }
    const data = await dispatchOps([{ op: 'set_core', source: 'card', card }], { label: t('设置了核心风格') })
    if (data && !data.errors?.length) setMode(null)
  }
  const extract = async () => {
    setBusy(true)
    const card = await extractStyle({ text: source.trim(), name: form.name.trim() })
    setBusy(false)
    if (card) setForm(cardToForm(card))
  }

  let body
  if (mode === 'skill') body = <SkillImport layer="core" onDone={() => setMode(null)} onCancel={() => setMode(null)} />
  else if (mode) {
    const previewed = mode !== 'extract' || form.name || form.summary || form.tone
    body = (
      <div className="md-style-edit">
        {mode === 'extract' ? (
          <>
            <label className="md-field">
              <span>{t('贴一些你写过的内容')}</span>
              <textarea rows={7} value={source} disabled={busy} onChange={event => setSource(event.target.value)} />
            </label>
            <div className="md-form-foot">
              <button type="button" className="md-btn" disabled={busy || !source.trim()} onClick={extract}>{busy ? t('提炼中…') : t('提炼')}</button>
            </div>
          </>
        ) : null}
        {previewed ? <CardEditor form={form} onChange={setForm} /> : null}
        <div className="md-form-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="md-btn" onClick={() => setMode(null)}>{t('取消')}</button>
          <button type="button" className="md-btn is-primary" disabled={!previewed} onClick={save}>{t('保存')}</button>
        </div>
      </div>
    )
  } else if (!core) {
    body = (
      <div className="md-style-entries">
        <button type="button" className="md-btn" onClick={() => open('skill')}><Icon name="upload" size={14} />{t('引入一个 skill')}</button>
        <button type="button" className="md-btn" onClick={() => open('extract')}><Icon name="spark" size={14} />{t('从我写过的内容提炼')}</button>
        <button type="button" className="md-btn" onClick={() => open('manual')}><Icon name="pen" size={14} />{t('手动填写')}</button>
      </div>
    )
  } else {
    body = (
      <>
        {core.source === 'skill' ? <CondensedEditor layer="core" row={core} /> : core.card?.summary ? <p>{core.card.summary}</p> : null}
        <div className="md-style-actions">
          {core.source === 'card' ? <button type="button" className="md-btn is-small" onClick={() => open('edit', core.card)}>{t('编辑')}</button> : null}
          <button type="button" className="md-btn is-small" onClick={() => open('skill')}>{t('重新引入')}</button>
          <button type="button" className="md-btn is-small is-danger" onClick={() => dispatchOps([{ op: 'clear_core' }], { label: t('清除了核心风格') })}>{t('清除')}</button>
        </div>
      </>
    )
  }

  return (
    <section className="md-panel md-style-block" aria-label={t('核心风格')}>
      <header>
        <h2>{t('核心风格')}</h2>
        {core && !mode ? <span className="md-inbox-tag">{core.name} · {sourceLabel(core)}</span> : null}
      </header>
      {body}
    </section>
  )
}

function TypeRow({ row, onlyOne }) {
  const [mode, setMode] = React.useState(null) // null | 'edit' | 'skill'
  const [name, setName] = React.useState(row.name)
  const [form, setForm] = React.useState(() => cardToForm(row.card))
  const begin = () => { setName(row.name); setForm(cardToForm(row.card)); setMode('edit') }
  const save = async () => {
    const op = { op: 'update_type', id: row.id, name: name.trim() }
    if (row.source === 'card') op.card = formToCard(form)
    const data = await dispatchOps([op], { label: t('改了内容类型') })
    if (data && !data.errors?.length) setMode(null)
  }
  return (
    <li className="md-style-type">
      <header>
        <h3>{row.name}</h3>
        <span className="md-inbox-tag">{sourceLabel(row)}</span>
        <span style={{ flex: 1 }} />
        {mode ? null : (
          <>
            <button type="button" className="md-btn is-small" onClick={begin}>{t('编辑')}</button>
            <button type="button" className="md-btn is-small" onClick={() => setMode('skill')}>{t('引入 skill')}</button>
            <button type="button" className="md-btn is-small is-danger" disabled={onlyOne} title={onlyOne ? t('至少保留一个内容类型') : undefined} onClick={() => dispatchOps([{ op: 'delete_type', id: row.id }], { label: t('删除了内容类型') })}>{t('删除')}</button>
          </>
        )}
      </header>
      {mode === 'skill' ? <SkillImport layer={row.id} onDone={() => setMode(null)} onCancel={() => setMode(null)} /> : null}
      {mode === 'edit' ? (
        <div className="md-style-edit">
          <label className="md-field"><span>{t('类型名称')}</span><input maxLength={20} value={name} onChange={event => setName(event.target.value)} /></label>
          {row.source === 'card' ? <CardEditor form={form} onChange={setForm} hideName /> : null}
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setMode(null)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" disabled={!name.trim()} onClick={save}>{t('保存')}</button>
          </div>
        </div>
      ) : null}
      {!mode && row.source === 'skill' ? <CondensedEditor layer={row.id} row={row} /> : null}
      {!mode && row.source === 'card' && row.card?.summary ? <p className="md-muted">{row.card.summary}</p> : null}
    </li>
  )
}

function TypesBlock() {
  const types = useDesk(s => s.state.voice?.types) ?? []
  const [name, setName] = React.useState('')
  const add = async (event) => {
    event.preventDefault()
    const data = await dispatchOps([{ op: 'add_type', name: name.trim(), card: {} }], { label: t('加了内容类型') })
    if (data && !data.errors?.length) setName('')
  }
  return (
    <section className="md-panel md-style-block" aria-label={t('内容类型')}>
      <header><h2>{t('内容类型')}</h2></header>
      <ul className="md-style-types">{types.map(row => <TypeRow key={row.id} row={row} onlyOne={types.length <= 1} />)}</ul>
      <form className="md-watch-add" onSubmit={add}>
        <input aria-label={t('新类型名称')} placeholder={t('新类型名称')} maxLength={20} value={name} onChange={event => setName(event.target.value)} />
        <button type="submit" className="md-btn" disabled={!name.trim()}><Icon name="plus" size={14} />{t('添加类型')}</button>
      </form>
    </section>
  )
}

function RuleRow({ row }) {
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(row.name)
  const [rule, setRule] = React.useState(row.rule)
  const on = row.status === 'active'
  const save = async () => {
    const data = await dispatchOps([{ op: 'update_rule', id: row.id, name: name.trim(), rule: rule.trim() }], { label: t('改了规则') })
    if (data && !data.errors?.length) setEditing(false)
  }
  return (
    <li className={`md-style-rule ${on ? '' : 'is-off'}`}>
      {editing ? (
        <div className="md-style-edit">
          <label className="md-field"><span>{t('规则名')}</span><input maxLength={60} value={name} onChange={event => setName(event.target.value)} /></label>
          <label className="md-field"><span>{t('规则内容')}</span><textarea rows={3} maxLength={500} value={rule} onChange={event => setRule(event.target.value)} /></label>
          <div className="md-form-foot">
            <span style={{ flex: 1 }} />
            <button type="button" className="md-btn" onClick={() => setEditing(false)}>{t('取消')}</button>
            <button type="button" className="md-btn is-primary" disabled={!name.trim() || !rule.trim()} onClick={save}>{t('保存')}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="md-style-rule-text">
            <b>{row.name}</b>
            <p>{row.rule}</p>
            {row.evidence ? <small className="md-muted">{row.evidence}</small> : null}
          </div>
          <label className="md-style-switch">
            <input type="checkbox" checked={on} onChange={() => dispatchOps([{ op: 'update_rule', id: row.id, status: on ? 'off' : 'active' }], { label: t('切换了规则') })} />
            <span>{on ? t('生效中') : t('已关闭')}</span>
          </label>
          <button type="button" className="md-btn is-small" onClick={() => { setName(row.name); setRule(row.rule); setEditing(true) }}>{t('编辑')}</button>
          <button type="button" className="md-icon-btn" aria-label={t('删除规则 {name}', { name: row.name })} title={t('删除')} onClick={() => dispatchOps([{ op: 'delete_rule', id: row.id }], { label: t('删除了规则') })}><Icon name="trash" size={14} /></button>
        </>
      )}
    </li>
  )
}

function RulesBlock() {
  const rules = useDesk(s => s.state.rules) ?? []
  const [name, setName] = React.useState('')
  const [rule, setRule] = React.useState('')
  const add = async (event) => {
    event.preventDefault()
    const data = await dispatchOps([{ op: 'add_rule', name: name.trim(), rule: rule.trim() }], { label: t('加了写作规则') })
    if (data && !data.errors?.length) { setName(''); setRule('') }
  }
  return (
    <section className="md-panel md-style-block" aria-label={t('写作规则')}>
      <header><h2>{t('写作规则')}</h2></header>
      {rules.length ? <ul className="md-style-rules">{rules.map(row => <RuleRow key={row.id} row={row} />)}</ul> : <p className="md-muted">{t('还没有规则。')}</p>}
      <form className="md-style-rule-add" onSubmit={add}>
        <input aria-label={t('规则名')} placeholder={t('规则名')} maxLength={60} value={name} onChange={event => setName(event.target.value)} />
        <input aria-label={t('规则内容')} placeholder={t('规则内容')} maxLength={500} value={rule} onChange={event => setRule(event.target.value)} />
        <button type="submit" className="md-btn" disabled={!name.trim() || !rule.trim()}><Icon name="plus" size={14} />{t('添加规则')}</button>
      </form>
    </section>
  )
}

export function StyleView() {
  const [tab, setTab] = React.useState('style')
  const hasState = useDesk(s => Boolean(s.state?.voice))
  return (
    <div className="md-page">
      <div className="md-style">
        <Segmented label={t('风格页标签')} value={tab} onChange={setTab} options={[{ value: 'style', label: t('风格') }, { value: 'watch', label: t('账号名单') }]} />
        {tab === 'watch' ? <WatchView /> : hasState ? (
          <>
            <p className="md-muted">{t('口吻以核心风格为准，结构以内容类型为准。')}</p>
            <CoreBlock />
            <TypesBlock />
            <RulesBlock />
          </>
        ) : <Empty title={t('还没有风格')} />}
      </div>
    </div>
  )
}
