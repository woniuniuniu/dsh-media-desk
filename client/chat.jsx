// 侧边对话：一句话改一切。解析和执行都在 Host，这里只负责展示回执。
import React from 'react'
import { clearChat, fetchMentions, openItem, sendChat, setDesk, undo, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { addMention, isComposing, mentionLimit, mentionMessage, mentionOptions, mentionToken, removeMentionToken } from './mentions.js'
import { Icon, IconButton } from './ui.jsx'

const SUGGESTIONS = [
  '记一下：地铁广告牌那句「慢一点也算到达」可以当开头',
  '接下来有什么排期？',
  '以后标题都不要超过 20 个字',
  '把今天最好的灵感一键成稿',
]

function Receipt({ receipt }) {
  const clickable = receipt.kind === 'item' && receipt.target
  const Tag = clickable ? 'button' : 'div'
  return (
    <Tag type={clickable ? 'button' : undefined} className="md-receipt" onClick={clickable ? () => openItem(receipt.target) : undefined}>
      <span className="md-receipt-check"><Icon name="check" size={11} stroke={2.2} /></span>
      <span>{receipt.text}</span>
    </Tag>
  )
}

function Message({ message, canUndoThis }) {
  if (message.role === 'user') return (
    <div className="md-msg is-user">
      {message.text}
      {message.mentions?.length ? <div className="md-mention-chips" aria-label={t('消息引用')}>{message.mentions.map(row => <span className="md-mention-chip" key={row.id}>{row.trigger || ''}{row.label || row.name || row.id}</span>)}</div> : null}
    </div>
  )
  return (
    <div className="md-msg is-bot">
      <p>{message.text}</p>
      {message.receipts?.map((receipt, index) => <Receipt key={index} receipt={receipt} />)}
      {message.errors?.map((error, index) => <p key={index} className="md-msg-error">{error}</p>)}
      {message.notice ? <p className="md-msg-note">{message.notice}</p> : null}
      <footer>
        <span>{message.engine === 'local' ? t('本地规则') : ''}</span>
        {canUndoThis ? <button type="button" onClick={undo}><Icon name="undo" size={12} />{t('撤销')}</button> : null}
      </footer>
    </div>
  )
}

/** 对话面板：首页的助手和成稿工作区共用。每条灵感有自己的对话。 */
export function ChatPanel({ itemId, head, top = null, suggestions, placeholder, disabled = false, intro = true }) {
  const all = useDesk(s => s.state.chat)
  const chat = React.useMemo(() => all.filter(m => (m.itemId ?? null) === (itemId ?? null)), [all, itemId])
  const thinking = useDesk(s => s.thinking)
  const quote = useDesk(s => s.chatQuote)
  const language = useLang()
  const [text, setText] = React.useState('')
  const [picked, setPicked] = React.useState([])
  const [picker, setPicker] = React.useState(null)
  const [catalog, setCatalog] = React.useState({ contexts: [], commands: [] })
  const [catalogReady, setCatalogReady] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [catalogError, setCatalogError] = React.useState(false)
  const [catalogRetry, setCatalogRetry] = React.useState(0)
  const [notice, setNotice] = React.useState('')
  const scroller = React.useRef(null)
  const input = React.useRef(null)
  const composing = React.useRef(false)
  const selection = React.useRef(null)
  const listId = React.useId()
  const helpId = React.useId()
  const open = Boolean(picker)
  const options = React.useMemo(() => mentionOptions(catalog, picker, picked), [catalog, picker, picked])
  const maxMentions = mentionLimit(catalog)

  React.useEffect(() => {
    if (scroller.current) scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [chat.length, thinking])
  React.useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  React.useEffect(() => {
    if (quote) input.current?.focus()
  }, [quote])
  React.useLayoutEffect(() => {
    if (selection.current === null || !input.current) return
    input.current.focus()
    input.current.setSelectionRange(selection.current, selection.current)
    selection.current = null
  })
  React.useEffect(() => {
    setText('')
    setPicked([])
    setPicker(null)
    setNotice('')
  }, [itemId])
  // 每次打开都读最新资料；成稿轮询等背景 state 更新不能取消或重排这个请求。
  React.useEffect(() => {
    if (!open) return
    let alive = true
    const controller = new AbortController()
    setLoading(true)
    setCatalogError(false)
    // 请求可能在浏览器连接池里排队；超时覆盖 fetch 和读取 body，而不永久显示读取中。
    const timeout = setTimeout(() => {
      if (!alive) return
      alive = false
      controller.abort()
      setCatalogError('timeout')
      setLoading(false)
    }, 10000)
    fetchMentions({ signal: controller.signal }).then(data => {
      if (alive) { setCatalog(data); setCatalogReady(true) }
    }).catch(() => {
      if (alive) setCatalogError(true)
    }).finally(() => {
      clearTimeout(timeout)
      if (alive) setLoading(false)
    })
    return () => { alive = false; clearTimeout(timeout); controller.abort() }
  }, [open, language, catalogRetry])
  React.useEffect(() => {
    if (picker && options.length) document.getElementById(`${listId}-${Math.min(picker.index, options.length - 1)}`)?.scrollIntoView({ block: 'nearest' })
  }, [picker?.index, options.length, listId])

  const updateInput = (element) => {
    setText(element.value)
    setNotice('')
    setPicker(composing.current ? null : mentionToken(element.value, element.selectionStart, element.selectionEnd))
  }
  const choose = (option) => {
    const el = input.current
    if (!option || !picker || !catalogReady) return
    // 鼠标或方向键把光标移出原位置后，旧浮层不可继续修改正文。
    if (!el || el.selectionStart !== picker.caret || el.selectionEnd !== picker.caret) { setPicker(null); return }
    const next = addMention(picked, option, picker.trigger, maxMentions)
    if (next.error) { setNotice(t('最多选择 {max} 个引用或指令', { max: maxMentions })); return }
    const replacement = removeMentionToken(text, picker)
    if (!replacement) { setPicker(null); return }
    selection.current = replacement.caret
    setText(replacement.text)
    setPicked(next.picked)
    setPicker(null)
    setNotice('')
  }

  const send = async (value) => {
    const message = mentionMessage(value ?? text, picked)
    if (!message || thinking || disabled) return
    setPicker(null)
    setNotice('')
    // 请求失败保留正文和选择，用户可以原样重试。
    if (await sendChat(message, { mentions: picked })) {
      setText('')
      setPicked([])
    } else if (value !== undefined) setText(value)
  }
  const onKeyDown = (event) => {
    if (isComposing(event, composing.current)) return
    if (picker) {
      if (event.key === 'Escape') { event.preventDefault(); setPicker(null); return }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { setPicker(null); return }
      if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setPicker(current => ({ ...current, index: (Math.min(current.index, options.length - 1) + direction + options.length) % options.length }))
        return
      }
      if (!event.shiftKey && (event.key === 'Enter' || event.key === 'Tab') && (loading || catalogError || options.length)) {
        event.preventDefault()
        choose(options[Math.min(picker.index, options.length - 1)])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }
  const lastBot = [...chat].reverse().find(m => m.role === 'assistant')

  return (
    <div className="md-chat">
      <header className="md-dock-head" data-window-drag="">{head}</header>
      <div className="md-dock-scroll" ref={scroller} aria-live="polite">
        {top}
        {chat.length === 0 && intro ? (
          <div className="md-dock-intro">
            <h3>{t('说一句话，')}<br />{t('剩下的我来补全。')}</h3>
            <p>{t('选题、灵感、内容、排期、风格和写作标准，都可以直接说。每一步都能撤销。')}</p>
            <p>{t('输入 @ 引用资料，输入 / 选择指令或 DSH Skill。')}</p>
          </div>
        ) : chat.map(message => <Message key={message.id} message={message} canUndoThis={message === lastBot && message.undoable} />)}
        {thinking ? <div className="md-msg is-bot"><span className="md-shimmer">{t('正在处理……')}</span></div> : null}
      </div>
      {suggestions?.length ? (
        <div className="md-suggest">
          {suggestions.slice(0, chat.length ? 2 : 4).map(row => <button type="button" key={row} onClick={() => send(row)} disabled={thinking || disabled}>{row}</button>)}
        </div>
      ) : null}
      <form className="md-composer" onSubmit={(event) => { event.preventDefault(); send() }}>
        {quote ? (
          <div className="md-composer-ctx">
            <Icon name="target" size={12} />
            <span>{quote.text ? t('{label}：{text}', { label: quote.label, text: quote.text }) : quote.label}</span>
            <button type="button" aria-label={t('取消引用')} onClick={() => setDesk({ chatQuote: null })}><Icon name="close" size={11} /></button>
          </div>
        ) : null}
        {picked.length ? (
          <div className="md-mention-chips" aria-label={t('已选择的引用与指令')}>
            {picked.map(row => <span className="md-mention-chip" key={row.id}><span className="md-mention-label">{row.trigger}{row.label}</span><button type="button" disabled={thinking} aria-label={t('移除引用 {name}', { name: row.label })} onClick={() => { setPicked(current => current.filter(item => item.id !== row.id)); setNotice('') }}><Icon name="close" size={11} /></button></span>)}
          </div>
        ) : null}
        {picker ? (
          <div className="md-mention-picker">
            <div className="md-mention-help" role="status">{loading ? (catalogReady ? t('正在刷新引用，已有引用仍可选择') : t('正在读取引用……')) : catalogError === 'timeout' ? t('读取引用超时，请重试') : catalogError ? t('读取引用失败，请重试') : picked.length >= maxMentions ? t('最多选择 {max} 个引用或指令', { max: maxMentions }) : t('↑↓ 选择，Enter 或 Tab 确认，Esc 关闭')}</div>
            {catalogError ? <button type="button" aria-label={t('重试读取引用')} onMouseDown={event => event.preventDefault()} onClick={() => setCatalogRetry(value => value + 1)}>{t('重试读取引用')}</button> : null}
            <div id={listId} role="listbox" aria-label={picker.trigger === '@' ? t('可引用的资料') : t('可用的指令')}>
              {!loading && !catalogError && !options.length ? <p className="md-mention-help">{t('没有匹配项')}</p> : null}
              {options.map((option, index) => (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === Math.min(picker.index, options.length - 1)}
                  disabled={!catalogReady || picked.length >= maxMentions}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choose(option)}
                  onMouseEnter={() => setPicker(current => current && ({ ...current, index }))}
                >
                  <span className="md-mention-option-head"><b>{option.name || option.id}</b><small>{option.group}</small></span>
                  {option.hint ? <span className="md-mention-option-hint">{option.hint}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <textarea
          ref={input}
          rows={1}
          aria-label={t('给助手发消息')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && options.length ? `${listId}-${Math.min(picker.index, options.length - 1)}` : undefined}
          aria-describedby={helpId}
          value={text}
          disabled={disabled || thinking}
          placeholder={placeholder}
          onChange={event => updateInput(event.target)}
          onSelect={event => { if (picker && (event.target.selectionStart !== picker.caret || event.target.selectionEnd !== picker.caret)) setPicker(null) }}
          onBlur={() => setPicker(null)}
          onCompositionStart={() => { composing.current = true; setPicker(null) }}
          onCompositionEnd={event => { composing.current = false; updateInput(event.target) }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="md-send" aria-label={t('发送')} disabled={(!text.trim() && !picked.length) || thinking || disabled}><Icon name="send" size={15} /></button>
        <span id={helpId} className="md-mention-status" role="status">{notice || (picked.length ? t('已选择 {n}/{max} 个引用或指令', { n: picked.length, max: maxMentions }) : t('输入 @ 引用资料，输入 / 选择指令或 DSH Skill。'))}</span>
      </form>
    </div>
  )
}

/** 选到了模型但调用失败：把服务返回的原因摆出来，不说成「没连上」。 */
function ModelAlert({ model, error }) {
  return (
    <div className="md-model-alert" role="status">
      <strong>{t('模型 {model} 调用失败', { model })}</strong>
      <p>{error.length > 280 ? `${error.slice(0, 280)}…` : error}</p>
    </div>
  )
}

export function ChatDock() {
  const model = useDesk(s => s.model)
  const modelOk = useDesk(s => s.modelOk)
  const modelError = useDesk(s => s.modelError)
  const hasChat = useDesk(s => s.state.chat.some(m => !m.itemId))
  return (
    <aside className="md-dock" aria-label={t('对话助手')}>
      <ChatPanel
        head={(
          <>
            <h2>{t('助手')}</h2>
            <span className={`md-engine ${!model ? '' : modelOk === false ? 'is-down' : 'is-live'}`} title={!model ? t('当前没有可用模型，只能处理常见说法') : modelOk === false ? `${t('模型 {model} 调用失败，现在只能处理常见说法。', { model })}${modelError ? `\n${modelError}` : ''}` : t('使用 DeepSeek Harness 当前模型 {model}', { model })}>
              <i />{!model ? t('本地规则') : modelOk === false ? t('模型调用失败') : model}
            </span>
            <span style={{ flex: 1 }} />
            {hasChat ? <IconButton icon="refresh" label={t('清空对话')} onClick={clearChat} /> : null}
            <IconButton icon="close" label={t('收起对话')} onClick={() => setDesk({ dockOpen: false })} />
          </>
        )}
        top={model && modelOk === false && modelError ? <ModelAlert model={model} error={modelError} /> : null}
        suggestions={SUGGESTIONS.map(row => t(row))}
        placeholder={t('想改什么，直接说')}
      />
    </aside>
  )
}
