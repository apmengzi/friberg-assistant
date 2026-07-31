from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / "work" / "scout-console.png"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:4173", wait_until="networkidle")

    assert page.locator("#playerCount").inner_text() == "646"
    assert page.locator("#dataStatus").inner_text() == "GAME POOL / 646"
    assert page.locator(".player-card").count() == 12

    page.locator("#searchInput").fill("z4kr")
    page.wait_for_timeout(100)
    assert page.locator("#resultsTitle").inner_text() == "1 条检索结果"
    assert page.locator(".player-card").first.locator("h3").inner_text() == "z4kr"

    page.screenshot(path=str(SCREENSHOT), full_page=True)
    browser.close()
