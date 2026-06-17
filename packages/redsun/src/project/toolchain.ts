import path from "path"
import { Instance } from "./instance"

export type ProjectProfile = {
  test: string | null
  build: string | null
  lint: string | null
  typecheck: string | null
  format: string | null
}

async function hasFile(dir: string, name: string): Promise<boolean> {
  return Bun.file(path.join(dir, name)).exists()
}

async function readJson(dir: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(path.join(dir, name))
    if (!await file.exists()) return null
    return await file.json()
  } catch {
    return null
  }
}

async function findUpFile(name: string, cwd: string, maxDepth = 5): Promise<string | null> {
  let dir = cwd
  for (let i = 0; i < maxDepth; i++) {
    if (await hasFile(dir, name)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function detectJsPm(cwd: string): Promise<string | null> {
  if (await findUpFile("pnpm-lock.yaml", cwd)) return "pnpm"
  if (await findUpFile("yarn.lock", cwd)) return "yarn"
  if (await findUpFile("bun.lock", cwd) || await findUpFile("bun.lockb", cwd)) return "bun"
  if (await findUpFile("package-lock.json", cwd)) return "npm"
  return null
}

function jsRun(pm: string | null): string {
  if (pm === "pnpm") return "pnpm"
  if (pm === "yarn") return "yarn"
  if (pm === "bun") return "bun"
  if (pm === "npm") return "npm"
  return "npx --yes"
}

type Scripts = Record<string, string | undefined>

async function readPackageScripts(cwd: string): Promise<Scripts | null> {
  const pkg = await readJson(cwd, "package.json")
  if (!pkg || typeof pkg !== "object") return null
  const scripts = (pkg as Record<string, unknown>).scripts
  if (!scripts || typeof scripts !== "object") return null
  return scripts as Scripts
}

const SCRIPT_MAP: Record<string, string> = {
  test: "test",
  build: "build",
  lint: "lint",
  typecheck: "typecheck",
  format: "format",
}

async function detectJsLinter(cwd: string): Promise<string | null> {
  if (await hasFile(cwd, "biome.json") || await hasFile(cwd, "biome.jsonc")) return "biome"
  if (await hasFile(cwd, "oxlintrc.json")) return "oxlint"
  if (await hasFile(cwd, "eslint.config.js") || await hasFile(cwd, "eslint.config.mjs") || await hasFile(cwd, ".eslintrc") || await hasFile(cwd, ".eslintrc.json")) return "eslint"
  return null
}

async function detectJsFormatter(cwd: string): Promise<string | null> {
  if (await hasFile(cwd, ".prettierrc") || await hasFile(cwd, ".prettierrc.json") || await hasFile(cwd, ".prettierrc.yaml") || await hasFile(cwd, ".prettierrc.toml")) return "prettier"
  return null
}

async function detectPythonPm(cwd: string): Promise<string | null> {
  if (await hasFile(cwd, "uv.lock")) return "uv"
  if (await hasFile(cwd, "poetry.lock")) return "poetry"
  if (await hasFile(cwd, "Pipfile.lock")) return "pipenv"
  return null
}

function jsProfile(run: string, cwd: string, linter: string | null, formatter: string | null, scripts: Scripts | null) {
  const profile: ProjectProfile = { test: null, build: null, lint: null, typecheck: null, format: null }

  const scriptAction = (action: string, fallback: string): string => {
    const scriptName = SCRIPT_MAP[action]
    if (scripts && scripts[scriptName]) return `${run} run ${scriptName}`
    return fallback
  }

  const actionOrScript = (action: string, cmd: string) => {
    const scriptName = SCRIPT_MAP[action]
    if (scripts && scripts[scriptName]) {
      profile[action as keyof ProjectProfile] = `${run} run ${scriptName}`
    } else {
      profile[action as keyof ProjectProfile] = cmd
    }
  }

  if (run === "bun") {
    actionOrScript("test", "bun test")
    actionOrScript("build", "bun run build")
    actionOrScript("typecheck", "bunx tsc --noEmit")
  } else {
    actionOrScript("test", `${run} test`)
    actionOrScript("build", `${run} build`)
    actionOrScript("typecheck", `${run} tsc --noEmit`)
  }

  if (linter === "biome") {
    profile.lint = `${run} biome check .`
    profile.format = `${run} biome check --write --unsafe .`
  } else if (linter === "oxlint") {
    profile.lint = `${run} oxlint .`
  } else if (linter === "eslint") {
    profile.lint = `${run} eslint .`
  } else if (scripts && scripts.lint) {
    profile.lint = `${run} run lint`
  }

  if (profile.format === null) {
    if (formatter === "prettier") {
      profile.format = `${run} prettier --check .`
    } else if (scripts && scripts.format) {
      profile.format = `${run} run format`
    }
  }

  return profile
}

export async function detectProfile(cwd: string = Instance.directory): Promise<ProjectProfile> {
  const scripts = await readPackageScripts(cwd)

  // Bun
  if (await hasFile(cwd, "bun.lock") || await hasFile(cwd, "bun.lockb")) {
    return jsProfile("bun", cwd, await detectJsLinter(cwd), await detectJsFormatter(cwd), scripts)
  }

  // JS/TS
  const pm = await detectJsPm(cwd)
  if (pm || await hasFile(cwd, "package.json")) {
    return jsProfile(jsRun(pm), cwd, await detectJsLinter(cwd), await detectJsFormatter(cwd), scripts)
  }

  // Rust
  if (await hasFile(cwd, "Cargo.toml")) {
    return {
      test: "cargo test",
      build: "cargo build",
      lint: "cargo clippy",
      typecheck: "cargo check",
      format: "cargo fmt --check",
    }
  }

  // Go
  if (await hasFile(cwd, "go.mod")) {
    const hasGolangci = await hasFile(cwd, ".golangci.yml") || await hasFile(cwd, ".golangci.yaml") || await hasFile(cwd, ".golangci.toml")
    return {
      test: "go test ./...",
      build: "go build ./...",
      lint: hasGolangci ? "golangci-lint run" : "go vet ./...",
      typecheck: "go build ./...",
      format: "gofmt -w -l .",
    }
  }

  // Python
  const pyproject = await hasFile(cwd, "pyproject.toml")
  const setupPy = await hasFile(cwd, "setup.py")
  const requirements = await hasFile(cwd, "requirements.txt")
  if (pyproject || setupPy || requirements) {
    const pyPm = await detectPythonPm(cwd)
    let test: string, lint: string, typecheck: string, format: string, build: string | null = null

    if (pyPm === "uv") {
      test = "uv run pytest"
      lint = "uv run ruff check ."
      typecheck = "uv run pyright ."
      format = "uv run ruff format --check ."
    } else if (pyPm === "poetry") {
      test = "poetry run pytest"
      lint = "poetry run ruff check ."
      typecheck = "poetry run pyright ."
      format = "poetry run ruff format --check ."
    } else {
      test = "pytest"
      lint = "ruff check ."
      typecheck = "pyright ."
      format = "ruff format --check ."
    }

    if (build === null && pyproject) {
      try {
        const content = await Bun.file(path.join(cwd, "pyproject.toml")).text()
        if (content.includes("[build-system]")) {
          build = pyPm === "uv" ? "uv build" : "pip install -e ."
        }
      } catch { /* ignore */ }
    }

    return { test, build, lint, typecheck, format }
  }

  // CMake
  if (await hasFile(cwd, "CMakeLists.txt")) {
    return { test: "ctest", build: "cmake --build .", lint: null, typecheck: null, format: null }
  }

  // Make
  if (await hasFile(cwd, "Makefile") || await hasFile(cwd, "makefile")) {
    return { test: "make test", build: "make", lint: null, typecheck: null, format: null }
  }

  return { test: null, build: null, lint: null, typecheck: null, format: null }
}
