"""End-to-end UI smoke for a disposable, freshly seeded server. Requires Playwright."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('SMOKE_URL', 'http://localhost:3210').rstrip('/')
password = os.environ.get('SMOKE_PASSWORD')
if not password:
    raise RuntimeError('SMOKE_PASSWORD must be set for the disposable test server')
out = Path('playwright-report')
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    launch = {'headless': True}
    if os.environ.get('CHROMIUM_PATH'):
        launch['executable_path'] = os.environ['CHROMIUM_PATH']
    browser = p.chromium.launch(**launch)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.goto(base + '/dashboard')
    page.get_by_label('Password', exact=True).fill(password)
    if page.get_by_label('Confirm password', exact=True).count():
        page.get_by_label('Confirm password', exact=True).fill(password)
        page.get_by_role('button', name='Set password & continue').click()
    else:
        page.get_by_role('button', name='Sign in', exact=True).click()
    expect(page.get_by_role('heading', name='Action Center', exact=True)).to_be_visible()
    state = page.request.get(base + '/api/snapshot').json()
    assert state['coverage'][0]['shortfall'] == '38.00'
    page.screenshot(path=str(out / 'dashboard-desktop.png'), full_page=True)
    pt = next(r for r in state['rules'] if r['type'] == 'interval_since_event')
    refreshable = next(r for r in state['rules'] if r['type'] == 'extend_by')
    for route, title in [('/services', 'Services'), ('/cashflows', 'Cash flows'), ('/wallets', 'Funding sources'), ('/counterparties', 'People & providers'), ('/settings/notifications', 'Notifications')]:
        page.goto(base + route)
        expect(page.get_by_role('heading', name=title, exact=True)).to_be_visible()
    page.get_by_role('button', name='Preview payloads').click()
    expect(page.locator('#payload-preview')).to_contain_text('PREVIEW_TOKEN_NOT_EXECUTABLE')
    page.goto(base + '/dashboard')
    page.get_by_role('button', name='Already logged in', exact=True).click()
    expect(page.locator('#toast')).to_contain_text('Recorded')
    changed = page.request.get(base + '/api/snapshot?horizon=365').json()
    from datetime import date, timedelta
    assert next(r for r in changed['rules'] if r['id'] == pt['id'])['next_due'] == str(date.fromisoformat(changed['today']) + timedelta(days=40))
    page.get_by_role('button', name='Extend 30 days', exact=True).click()
    expect(page.locator('#toast')).to_contain_text('Expiry updated')
    changed = page.request.get(base + '/api/snapshot?horizon=365').json()
    assert next(r for r in changed['rules'] if r['id'] == refreshable['id'])['expiry_at'] == str(date.fromisoformat(refreshable['expiry_at']) + timedelta(days=30))
    page.get_by_role('button', name='Mark received', exact=True).first.click()
    expect(page.locator('#toast')).to_contain_text('received')
    page.get_by_role('button', name='+ Add service').click()
    page.get_by_label('Name', exact=True).fill('Browser-created service')
    page.get_by_role('dialog').get_by_role('button', name='Save changes', exact=True).click()
    expect(page.get_by_role('dialog')).not_to_be_visible()
    page.goto(base + '/services')
    expect(page.get_by_role('link', name='Browser-created service', exact=True)).to_be_visible()
    page.goto(base + '/dashboard')
    expect(page.get_by_role('heading', name='Action Center', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='Dark mode', exact=True).click()
    page.screenshot(path=str(out / 'dashboard-mobile-dark.png'), full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile horizontal overflow'
    assert not errors, errors
    page.get_by_role('button', name='Sign out', exact=True).click()
    expect(page.get_by_role('button', name='Sign in', exact=True)).to_be_visible()
    browser.close()
print(json.dumps({'browser_smoke': 'passed', 'page_errors': errors}))
