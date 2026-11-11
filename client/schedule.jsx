// 排期：后续任务接入。
import React from 'react'
import { t } from './util.js'
import { Empty } from './ui.jsx'

export function ScheduleView() {
  return (
    <div className="md-page">
      <Empty title={t('还没有排期')} hint={t('排期将在后续任务接入。')} />
    </div>
  )
}
