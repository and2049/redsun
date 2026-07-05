
## Install

**Linux / macOS / WSL:**

```bash
curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash
```

testing version:

```bash
curl -fsSL https://github.com/and2049/redsun/releases/latest/download/install | bash -s -- --pre-release
```

**Windows (PowerShell):**

```powershell
irm https://github.com/and2049/redsun/releases/latest/download/install.ps1 | iex
```

testing version:

```powershell
& ([scriptblock]::Create((irm https://github.com/and2049/redsun/releases/latest/download/install.ps1))) -PreRelease
```
