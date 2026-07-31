from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / "outputs" / "local-mirror-auto.png"


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1100})
    page.goto("http://127.0.0.1:4174/mirror/", wait_until="networkidle")

    assert "题库已载入：646 人" in page.locator("#automationStatus").inner_text()
    assert page.locator("#answerSelect option").count() == 646

    # A person can submit an exact playerId choice before using automation.
    page.locator("#guessInput").fill("refrezh")
    page.locator('[data-friberg-option]').filter(has_text="refrezh").first.click()
    assert page.locator("#submitGuess").is_enabled()
    page.locator("#submitGuess").click()
    assert page.locator('[data-friberg-feedback-row]').count() == 1

    # Start a clean authorized local round, then let the state machine act only
    # after the page-level consent checkbox is explicitly checked.
    page.locator("#newRound").click()
    page.locator("#automationConsent").check()
    page.locator("#autoRun").click()
    page.wait_for_function("() => document.querySelector('#fribergMirror').dataset.roundStatus === 'won'", timeout=10000)

    rows = page.locator('[data-friberg-feedback-row]').count()
    assert 1 <= rows <= 8
    assert "胜利" in page.locator("#roundResult").inner_text()
    assert "本地自动化胜利" in page.locator("#automationStatus").inner_text()

    SCREENSHOT.parent.mkdir(exist_ok=True)
    page.screenshot(path=str(SCREENSHOT), full_page=True)
    browser.close()

print('{"suite":"local-mirror-browser","status":"passed"}')
