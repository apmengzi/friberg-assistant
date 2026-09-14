import json
from pathlib import Path

from playwright.sync_api import sync_playwright


PROJECT_ROOT = Path(__file__).resolve().parent.parent
HARNESS = PROJECT_ROOT / "tests" / "fixtures" / "license-gate-harness.html"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 760})
    page.goto(HARNESS.as_uri())
    page.wait_for_load_state("networkidle")

    gate = page.locator("#friberg-license-gate")
    gate.wait_for(state="attached")
    assert gate.locator("h1").inner_text() == "弗一把助手 · 付费测试版"
    assert (
        gate.locator("#friberg-device-code").inner_text()
        == "FRB-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AABB"
    )

    license_field = gate.locator("textarea")
    license_field.fill("FRIBERG1.TEST.VALID")
    gate.locator("#friberg-activate").click()
    assert license_field.input_value() == ""
    page.wait_for_function("document.body.dataset.licenseActive === 'true'")
    page.wait_for_function("!document.getElementById('friberg-license-gate')")

    messages = page.evaluate("globalThis.__licenseMessages")
    assert [message["action"] for message in messages[:2]] == ["status", "activate"]
    assert messages[1]["licenseText"] == "FRIBERG1.TEST.VALID"
    browser.close()

print(
    json.dumps(
        {
            "suite": "offline-license-gate-browser",
            "activationPage": True,
            "deviceCodeVisible": True,
            "rawLicenseRemovedFromDom": True,
            "status": "passed",
        },
        ensure_ascii=False,
    )
)
