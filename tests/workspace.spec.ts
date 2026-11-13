import { expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { account, Client, issuedPassword, masterPassword } from './fixtures.js'

import type { CaseRecord } from '../apps/web/src/types.js'

const origin = 'http://127.0.0.1:38509'
test.beforeAll(async () => {
  await account(origin, 'bootstrap', masterPassword)
  await account(origin, 'recover', masterPassword)
})

test('workspace keeps editor state in tabs, synchronizes two sessions, and works at narrow widths', async ({
  page,
  browser,
}, info) => {
  const owner = new Client(origin)
  await owner.call('/auth/login', 'POST', { username: 'mercia', password: masterPassword })
  const partner = await owner.call<{ code: string }>(
    '/accounts',
    'POST',
    {
      username: 'browser-partner-' + randomBytes(4).toString('hex'),
      displayName: 'Fictional Browser Partner',
      role: 'INVESTIGATOR',
    },
    201,
  )
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  try {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Username')).toBeFocused()
    await page.getByLabel('Username').fill('mercia')
    await page.getByLabel('Password', { exact: true }).fill(masterPassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'My cases' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('dashboard-desktop.png') })

    const title =
      'Fictional north rail inspection ' +
      'long record name for overflow verification '.repeat(3).trim()
    await page.getByRole('link', { name: 'New case' }).click()
    await page.getByLabel('Case title').fill(title)
    await page.getByLabel('Start the main incident report with headings').uncheck()
    await page.getByRole('button', { name: 'Create case' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    const caseUrl = page.url()
    const caseId = caseUrl.split('/').at(-1)!
    await page.getByRole('link', { name: 'Main incident report' }).click()
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    const reportUrl = page.url()

    await other.goto(reportUrl)
    await other.getByRole('button', { name: 'Activate account or reset password' }).click()
    await other.getByLabel('One-time code').fill(partner.code)
    await other
      .getByLabel('Password', { exact: false })
      .filter({ visible: true })
      .first()
      .fill(issuedPassword)
    await other.getByRole('button', { name: 'Set password' }).click()
    await expect(other.getByText('Saved', { exact: true })).toBeVisible()
    await expect(page.getByText('Also here · Fictional Browser Partner')).toBeVisible()

    const editor = page.getByRole('textbox', { name: 'Main incident report editor' })
    const peer = other.getByRole('textbox', { name: 'Main incident report editor' })
    await Promise.all([editor.click(), peer.click()])
    await Promise.all([
      page.keyboard.insertText('Investigators recorded the depot access log. '),
      other.keyboard.insertText('Witnesses described a blue delivery vehicle. '),
    ])
    await expect(editor).toContainText('blue delivery vehicle')
    await expect(peer).toContainText('depot access log')
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await expect(other.getByText('Saved', { exact: true })).toBeVisible()
    await editor.press('Control+End')
    await page.keyboard.insertText('Local revision for the undo check.')
    await expect(peer).toContainText('Local revision for the undo check.')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(peer).not.toContainText('Local revision for the undo check.')
    await expect(peer).toContainText('blue delivery vehicle')
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(peer).toContainText('Local revision for the undo check.')
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()

    await editor.press('Control+End')
    await editor.press('Enter')
    await page.keyboard.insertText(
      'A long fictional incident narrative for checking reading width and scrolling. '.repeat(100),
    )
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Submit report', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Submit report', exact: true }).click()
    await expect(page.getByText(/Submitted \d/).filter({ visible: true })).toBeVisible()

    const tabs = page.getByRole('navigation', { name: 'Open records' })
    await expect(tabs.getByRole('link')).toHaveCount(2)
    const panel = page.locator('.workspace-panel:visible')
    await panel.evaluate((element) => {
      element.scrollTop = 400
    })
    const scroll = await panel.evaluate((element) => element.scrollTop)
    expect(scroll).toBeGreaterThan(0)
    await tabs.getByRole('link', { name: new RegExp(title) }).click()
    await expect(page).toHaveURL(caseUrl)
    await tabs.getByRole('link', { name: 'Main incident report' }).click()
    await expect(editor).toContainText('long fictional incident narrative')
    await expect(editor).toContainText('blue delivery vehicle')
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBe(scroll)
    await page.reload()
    await expect(tabs.getByRole('link')).toHaveCount(2)
    await expect(editor).toContainText('depot access log')
    await expect(editor).toContainText('blue delivery vehicle')
    await page.screenshot({ path: info.outputPath('report-desktop.png') })

    const blocked = 'https://i.imgur.com/nonexistent-test.png?preserve=1'
    await page.route(blocked, (route) => route.abort())
    await owner.call(
      '/cases/' + caseId + '/evidence',
      'POST',
      { title: 'Unavailable fictional image', type: 'IMAGE', sourceUrl: blocked },
      201,
    )
    await tabs.getByRole('link', { name: new RegExp(title) }).click()
    await page.getByRole('button', { name: 'Archive case', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Archive case' })
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Archive case', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Evidence', exact: true }).click()
    await expect(page.getByText('Image unavailable or expired.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', blocked)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBeTruthy()
    await page.screenshot({ path: info.outputPath('case-narrow.png') })
    await tabs.getByRole('link', { name: 'Main incident report' }).click()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBeTruthy()
    await expect(editor).toContainText('blue delivery vehicle')
    await page.screenshot({ path: info.outputPath('report-narrow.png') })
    await tabs.getByRole('link', { name: new RegExp(title) }).click()
    await page.getByRole('link', { name: 'Case packet' }).click()
    await page.getByRole('button', { name: 'Prepare packet' }).click()
    await expect(page.getByRole('article')).toContainText('blue delivery vehicle')
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download JSON' }).click()
    expect((await downloaded).suggestedFilename()).toMatch(/^CR-\d+-\d+\.json$/)
  } finally {
    await otherContext.close()
  }
})

test('casework uses local time, templates, penal-code totals, and typed deletion', async ({
  browser,
}) => {
  const context = await browser.newContext({
    timezoneId: 'America/Los_Angeles',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  const code = 'B-' + randomBytes(3).toString('hex').toUpperCase()
  const title = 'Fictional casework ' + code
  try {
    await page.goto('/')
    await page.getByLabel('Username').fill('mercia')
    await page.getByLabel('Password', { exact: true }).fill(masterPassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByText('Times shown in America/Los_Angeles')).toBeVisible()
    await page.getByRole('link', { name: 'Administration' }).click()
    await page.getByRole('button', { name: 'Penal code', exact: true }).click()
    await page.getByRole('button', { name: 'New charge' }).click()
    await page.getByLabel('Statute or charge code').fill(code)
    await page.getByLabel('Charge title').fill('Fictional permit entry')
    await page.getByLabel('Custody time in minutes').fill('35')
    await page.getByLabel('Fine (USD)').fill('75.25')
    await page.getByRole('button', { name: 'Create charge' }).click()
    await page.getByLabel('Search the penal code').fill(code)
    await expect(page.getByRole('row').filter({ hasText: code })).toContainText('$75.25')

    const owner = new Client(origin)
    await owner.call('/auth/login', 'POST', { username: 'mercia', password: masterPassword })
    await page.getByRole('link', { name: 'Cases', exact: true }).click()
    await page.getByRole('link', { name: 'New case' }).click()
    await page.getByLabel('Case title').fill(title)
    await page.getByLabel('Incident date and time (local)').fill('2026-11-11T21:00')
    await page.getByLabel('Start the main incident report with headings').uncheck()
    await page.getByRole('button', { name: 'Create case' }).click()
    await expect(page.getByRole('heading', { name: title })).toBeVisible()
    const path = new URL(page.url()).pathname
    const record = await owner.call<CaseRecord>(path)
    expect(record.occurredAt).toBe('2026-11-12T05:00:00.000Z')
    await page.getByRole('link', { name: 'Main incident report' }).click()
    const report = page.getByRole('textbox', { name: 'Main incident report editor' })
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await expect
      .poll(() =>
        report.evaluate((el) => {
          const paper = el.closest('.paper')!
          const style = getComputedStyle(paper)
          return Math.abs(
            el.clientWidth -
              (paper.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
          )
        }),
      )
      .toBeLessThan(2)
    await report.press('Control+End')
    await page.keyboard.insertText('Investigators verified the documents supplied by the witness.')
    await page.getByRole('button', { name: 'Insert template' }).click()
    await expect(report).toContainText('documents supplied by the witness')
    await expect(report.getByRole('heading', { name: 'Incident narrative' })).toHaveCount(1)
    await page.getByRole('button', { name: 'Insert template' }).click()
    await expect(report.getByRole('heading', { name: 'Incident narrative' })).toHaveCount(1)
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
    await page.getByRole('link', { name: 'Manage suspect charges' }).click()
    await expect(page).toHaveURL(/section=People/)
    await page.getByRole('button', { name: 'Add suspect' }).click()
    await page.getByLabel('Name as recorded').fill('Fictional Taylor')
    await page.getByRole('button', { name: 'Add person' }).click()
    await page.getByRole('button', { name: 'Assign charges' }).click()
    await page.getByLabel('Find a penal code charge').fill(code)
    await page.getByRole('button', { name: new RegExp(code + ' · Fictional permit entry') }).click()
    await page.getByLabel('Count for ' + code).fill('2')
    await expect(page.getByText('Estimated total', { exact: true }).locator('..')).toContainText(
      '$150.50',
    )
    await page.getByRole('button', { name: 'Save charges' }).click()
    await expect(page.getByText(/Charges · 1 hr 10 min ·/)).toContainText('$150.50')
    await page
      .getByRole('navigation', { name: 'Open records' })
      .getByRole('link', { name: 'Main incident report' })
      .click()
    await expect(page.getByRole('heading', { name: 'Fictional Taylor' })).toBeVisible()
    await expect(page.getByText('Total', { exact: true }).locator('..')).toContainText('$150.50')

    await page
      .getByRole('navigation', { name: 'Open records' })
      .getByRole('link', { name: new RegExp(title) })
      .click()
    await page.getByRole('button', { name: 'Documents', exact: true }).click()
    await page.getByRole('button', { name: 'Draft legal paperwork' }).click()
    await page.getByLabel('Document title').fill('Fictional subpoena draft')
    await page.getByRole('button', { name: 'Create legal draft' }).click()
    await expect(
      page.getByText('Draft for review. Record the issuing authority and approval before use.'),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Issuing authority and approval' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBeTruthy()
    await page
      .getByRole('navigation', { name: 'Open records' })
      .getByRole('link', { name: new RegExp(title) })
      .click()
    await page.getByRole('button', { name: 'Delete case', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete case' })
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await dialog.getByLabel('Type ' + record.number + ' to confirm').fill(record.number)
    await dialog.getByRole('button', { name: 'Delete case' }).click()
    await expect(page.getByRole('heading', { name: 'Cases', exact: true })).toBeVisible()
    await owner.call(path, 'GET', undefined, 404)
  } finally {
    await context.close()
  }
})
