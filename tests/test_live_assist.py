import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4176"


def shadow_text(page, selector):
    return page.evaluate(
        """selector => {
          const host = document.querySelector('#friberg-scriptcat-assistant');
          return host?.shadowRoot?.querySelector(selector)?.textContent || '';
        }""",
        selector,
    )


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    page.goto(f"{BASE}/tests/fixtures/live-assist-extension-harness.html", wait_until="networkidle")

    page.wait_for_selector("#friberg-assistant-overlay")
    assert "等待对局" in page.locator("[data-fa-status]").inner_text()
    assert page.locator("[data-fa-pool-metric]").inner_text() == "646"
    assert page.locator("[data-fa-listener]").inner_text() == "运行中"
    assert page.locator("[data-fa-board]").inner_text() == "尚未发现"

    page.evaluate("history.pushState({}, '', '/multi/room')")
    page.wait_for_function("() => document.querySelector('[data-fa-route]').textContent === '/multi/room'")
    assert page.locator("#friberg-assistant-overlay").count() == 1

    page.evaluate("fixtureBoard()")
    page.wait_for_function("() => document.querySelector('[data-fa-board]').textContent.includes('已绑定')")
    page.wait_for_function("() => document.querySelector('[data-fa-next]').textContent !== '等待反馈'")
    assert page.locator("[data-fa-candidates]").inner_text() != "646"
    ownership = page.evaluate(
        """() => {
          const scan = FribergLiveDomAdapter.scan(document);
          return {
            ownBoardCount: scan.ownBoardCount,
            autoOwnership: scan.autoBoard?.ownership,
            candidates: scan.boardCandidates.map(candidate => candidate.ownership),
          };
        }"""
    )
    assert ownership == {"ownBoardCount": 1, "autoOwnership": "self", "candidates": ["self", "opponent"]}

    page.evaluate("fixtureAddSecondRow()")
    page.wait_for_function("() => document.querySelector('[data-fa-detail]').textContent.includes('2 次可见猜测')")
    assert page.locator("[data-fa-next]").inner_text() != "最新反馈待识别"
    assert page.locator("[data-fa-candidates]").inner_text() != "0"

    page.wait_for_function("() => !document.querySelector('[data-fa-action=fill]').disabled")
    page.locator('[data-fa-action="fill"]').click()
    page.wait_for_function("() => document.querySelector('#guess-input').value.length > 0")
    page.wait_for_function("() => window.__fixtureSelected === document.querySelector('#guess-input').value")
    assert page.evaluate("window.__fixtureSubmitClicks") == 0
    page.wait_for_function("() => !document.querySelector('[data-fa-action=submit]').disabled")
    page.locator('[data-fa-action="submit"]').click()
    page.wait_for_function("() => window.__fixtureSubmitClicks === 1")
    assert page.locator('[data-fa-action="submit"]').is_disabled()

    with page.expect_download() as download_info:
        page.locator('[data-fa-action="download-diagnostic"]').click()
    diagnostic_download = download_info.value
    assert diagnostic_download.suggested_filename.startswith("friberg-diagnostic-")
    diagnostic = json.loads(Path(diagnostic_download.path()).read_text(encoding="utf-8"))
    for key in ["url", "route", "candidateBoards", "candidateInputs", "candidateButtons", "recentMutations", "adapterState", "errors"]:
        assert key in diagnostic
    assert diagnostic["gamePoolSize"] == 646
    assert diagnostic["privacy"]["cookies"] == "not collected"

    zero = page.evaluate(
        """() => {
          fixtureZeroOptions();
          const result = FribergLiveDomAdapter.uniqueOptionForPlayer({
            player: { nick: 'Zero', playerId: 'zero-cn', country: '中国', team: 'Fixture' },
            players: [
              { nick: 'Zero', playerId: 'zero-cn', country: '中国', team: 'Fixture' },
              { nick: 'Zero', playerId: 'zero-sk', country: '斯洛伐克', team: 'Fixture' },
            ],
            documentRef: document,
          });
          return { status: result.status, playerId: result.descriptor?.attributes?.data?.['data-player-id'] || null };
        }"""
    )
    assert zero == {"status": "unique", "playerId": "zero-cn"}

    random_page = browser.new_page(viewport={"width": 1440, "height": 1000})
    random_page.goto(f"{BASE}/tests/fixtures/live-assist-extension-harness.html", wait_until="networkidle")
    random_page.wait_for_function("() => !document.querySelector('[data-fa-action=random-first]').disabled")
    random_page.locator('[data-fa-action="random-first"]').click()
    random_page.wait_for_function("() => document.querySelector('#guess-input').value.length > 0")
    random_page.wait_for_function("() => window.__fixtureSelected === document.querySelector('#guess-input').value")
    random_page.wait_for_function("() => !document.querySelector('[data-fa-action=submit]').disabled")
    random_page.locator('[data-fa-action="submit"]').click()
    random_page.wait_for_function("() => window.__fixtureSubmitClicks === 1")
    assert random_page.locator('[data-fa-action="submit"]').is_disabled()

    unknown_page = browser.new_page(viewport={"width": 1440, "height": 1000})
    unknown_page.goto(f"{BASE}/tests/fixtures/live-assist-extension-harness.html", wait_until="networkidle")
    unknown_page.evaluate("fixtureBoard({unknown: true})")
    unknown_page.wait_for_function("() => document.querySelector('[data-fa-status]').textContent.includes('最新反馈尚未识别')")
    assert "correct/close/wrong" in unknown_page.locator("[data-fa-error]").inner_text()

    scriptcat = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    scriptcat.goto(f"{BASE}/tests/fixtures/live-assist-scriptcat-harness.html", wait_until="networkidle")
    scriptcat.wait_for_selector("#friberg-scriptcat-assistant")
    assert "等待对局" in shadow_text(scriptcat, "[data-status]")
    assert shadow_text(scriptcat, "[data-listener]") == "运行中"
    assert shadow_text(scriptcat, "[data-board]") == "尚未发现"

    scriptcat.evaluate("history.pushState({}, '', '/multi/room')")
    scriptcat.wait_for_function("() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-route]')?.textContent === '/multi/room'")
    assert scriptcat.locator("#friberg-scriptcat-assistant").count() == 1
    scriptcat.wait_for_function("() => !document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-action=random-first]').disabled")
    scriptcat.evaluate("document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-action=random-first]').click()")
    scriptcat.wait_for_function("() => document.querySelector('#guess-input').value.length > 0")
    scriptcat.wait_for_function("() => window.__fixtureSelected === document.querySelector('#guess-input').value")
    scriptcat.wait_for_function("() => !document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-action=submit]').disabled")
    scriptcat.evaluate("document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-action=submit]').click()")
    scriptcat.wait_for_function("() => window.__fixtureSubmitClicks === 1")

    scriptcat.evaluate("fixtureBoard()")
    scriptcat.wait_for_function("() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-board]')?.textContent.includes('已绑定')")
    scriptcat.wait_for_function("() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-next]')?.textContent !== '等待反馈'")
    scriptcat.evaluate("fixtureAddSecondRow()")
    scriptcat.wait_for_function("() => document.querySelector('#friberg-scriptcat-assistant')?.shadowRoot?.querySelector('[data-guesses]')?.textContent === '2 / 8'")
    assert shadow_text(scriptcat, "[data-next]") != "最新反馈待识别"
    assert shadow_text(scriptcat, "[data-candidates]") != "0"

    with scriptcat.expect_download() as scriptcat_download_info:
        scriptcat.evaluate("document.querySelector('#friberg-scriptcat-assistant').shadowRoot.querySelector('[data-action=export]').click()")
    scriptcat_download = scriptcat_download_info.value
    assert scriptcat_download.suggested_filename.startswith("friberg-diagnostic-")

    browser.close()

print('{"suite":"live-assist-harness","extension":"passed","scriptcat":"passed","status":"passed"}')
