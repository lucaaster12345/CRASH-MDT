import { expect, test } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { account, Client, issuedPassword, masterPassword } from './fixtures.js'

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
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
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
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
    await expect(other.getByText('Saved', { exact: true })).toBeVisible()
    await editor.press('Control+End')
    await page.keyboard.insertText('Local revision for the undo check.')
    await expect(peer).toContainText('Local revision for the undo check.')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(peer).not.toContainText('Local revision for the undo check.')
    await expect(peer).toContainText('blue delivery vehicle')
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(peer).toContainText('Local revision for the undo check.')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()

    await editor.press('Control+End')
    await editor.press('Enter')
    await page.keyboard.insertText(
      'A long fictional incident narrative for checking reading width and scrolling. '.repeat(100),
    )
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()
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
