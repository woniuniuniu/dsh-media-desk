// 英文词典：key 是界面里的中文原文。按页面分文件，避免一个文件太长。
import { ACCOUNTS } from './accounts.js'
import { CORE } from './core.js'
import { PAGES } from './pages.js'
import { STUDIO } from './studio.js'
import { CONTENT_LAB } from './content-lab.js'

export const EN = { ...ACCOUNTS, ...CORE, ...PAGES, ...STUDIO, ...CONTENT_LAB }
