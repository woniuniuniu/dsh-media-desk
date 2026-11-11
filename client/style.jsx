// 风格：后续任务接入。
import React from 'react'
import { t } from './util.js'
import { Empty } from './ui.jsx'

export function StyleView() {
  return (
    <div className="md-page">
      <Empty title={t('还没有风格')} hint={t('风格将在后续任务接入。')} />
    </div>
  )
}
