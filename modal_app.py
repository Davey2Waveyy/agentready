# Hosts AgentReady on Modal: one container runs the Node app server next to Google Chrome
# (Read and Verify drive a real browser, so this can't be serverless functions).
#   modal secret create agentready --from-dotenv .env    (once)
#   modal run modal_app.py::check                         (Chrome + WebMCP work on Linux?)
#   modal deploy modal_app.py
import os
import subprocess

import modal

image = (
    modal.Image.debian_slim()
    .apt_install("curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs",
        "curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
        " && apt-get install -y /tmp/chrome.deb && rm /tmp/chrome.deb",
    )
    .add_local_file("package.json", "/app/package.json", copy=True)
    .add_local_file("package-lock.json", "/app/package-lock.json", copy=True)
    .run_commands("cd /app && npm ci")
    .add_local_dir(".", "/app", ignore=[".git", "node_modules", "reports", ".env", ".claude", "PLAN.md", "*.py", "__pycache__"])
)
app = modal.App("agentready", image=image)
data = modal.Volume.from_name("agentready-data", create_if_missing=True)  # approved configs survive restarts

CHECK = """
import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-features=WebMCPTesting'] });
const p = await b.newPage();
await p.route('https://check.test/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ok</title>' }));
await p.goto('https://check.test/');
console.log(JSON.stringify({ chrome: b.version(), webmcp: await p.evaluate(() => !!document.modelContext) }));
await b.close();
"""


@app.function()
def check():
    subprocess.run(["node", "--input-type=module", "-e", CHECK], cwd="/app", check=True)


# ponytail: one container (max_containers=1) because running jobs and the mock calendar live in its memory
@app.function(
    secrets=[modal.Secret.from_name("agentready")],
    volumes={"/data": data},
    cpu=1,
    memory=3072,
    max_containers=1,
    scaledown_window=600,
    timeout=3600,
)
@modal.concurrent(max_inputs=50)
@modal.web_server(3100, startup_timeout=60)
def web():
    # AGENTREADY_MOCK: the public demo never books on the real Cal.com calendar
    subprocess.Popen(["node", "dev.mjs"], cwd="/app", env={**os.environ, "PORT": "3100", "AGENTREADY_DATA": "/data", "AGENTREADY_MOCK": "1"})
