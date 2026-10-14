/**
 * LH 自己的**目录定位** —— 不许写死盘符，也不许让宿主的启动依赖环境变量。
 *
 * ═══ 为什么这个文件存在（它是一次真实缺陷的产物）═══
 * 原先 `store.js` 里是 `const DEFAULT_DATA_DIR = 'D:\\LearningHarnessv0.1\\data'`。
 * 这类写死**不会让插件跑不起来**，它会让插件**在别人的机器上跑错目录**——
 * 而那是静默错误：表现为"数据不见了""题库是空的""进度是 0"，而不是报错。
 *
 * 实测的四个写死点里，有一个**已经指的是错的工作区**（作者改过文件夹名，
 * 一处跟着改了、另一处没有）。所以这条不只是"为了分发"，它自己就先受益。
 *
 * ═══ 但"靠往上找仓库根"有一个致命的缺口（2026-09-18 实测撞上）═══
 * 本包被 pnpm 装进 `profiles/web/node_modules/@lh/event-store/` 之后，
 * **它的上方根本没有仓库**——从那里往上找 `package.json` 里 name 是
 * `lh-workspace` 的那一级，永远找不到。
 *
 * 后果不是"数据放错地方"，而是 `dataDir()` 抛错 → 插件 `apply()` 抛错 →
 * **整棵插件树加载失败 → dsh 完全起不来**。
 *
 * 讽刺的是这个缺口一直是**被写死的绝对路径挡住的**：profile 里那份旧拷贝
 * 用的还是 `DEFAULT_DATA_DIR = 'D:\...'`，所以"能跑"。也就是说，
 * 那次"去掉写死路径"的重构，会在下一次重启时把 dsh 弄坏——
 * 而它当时"测过了"，因为测试跑的是源码树（源码树上方**确实**有仓库）。
 *
 * ═══ 所以：装的时候知道，就别让运行时去猜 ═══
 * `lh-install.json` 是**安装/同步时写下的**配置文件，放在
 * "包的上方某一级"（源码树里就是仓库根；profile 里就是 `profiles/<名>/`）。
 * 运行时往上找一个**配置文件**（而不是一个约定俗成的标记），拿到：
 *
 *   - `repo_root`：LH 仓库根（数据默认放它下面的 `data/`）
 *   - `data_dir`：显式覆盖（想让数据离开仓库时用）
 *   - `workspace`：学习者的工作区（内含 `lh-questions/` 的那个目录）
 *
 * 这样 profile 拷贝也能自己找到家，**不需要任何环境变量**——
 * 而"需要环境变量才能启动"本身就是个陷阱：忘了设，dsh 就起不来，
 * 而学习者被困在没有入口的界面里，连怎么修都看不到。
 *
 * ═══ 优先级（从高到低）═══
 * 1. 显式环境变量（`LH_DATA_DIR` / `LH_WORKSPACE`）：测试沙盒与临时覆盖用。
 *    **必须先查它**，否则"把它指到别处"会被静默忽略。
 * 2. 往上找最近的 `lh-install.json`。
 * 3. （仅数据目录）往上找 name 为 `lh-workspace` 的 package.json —— 没有配置
 *    文件的源码树靠它兜底。
 * 4. 数据目录都没有 → **抛错，而不是猜一个默认值**。
 *    但**这个错误必须发生在"用的时候"，不能发生在"装载的时候"**——
 *    装载时抛错会让宿主起不来，那不是"响亮"，那是把学习者锁在门外。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根的标记：工作区根的 package.json 里这个名字是唯一的（没有配置文件时的兜底）。 */
const REPO_MARKER_NAME = 'lh-workspace'

/** 安装期写下的配置文件的名字。同步脚本与部署工具都写它，运行时读它。 */
export const INSTALL_CONFIG_FILENAME = 'lh-install.json'

/** 本模块所在目录，作为往上找的起点。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 从某个目录往上找安装配置。
 *
 * 为什么用"往上找文件"而不是固定层数：本包被装进
 * `profiles/web/node_modules/@lh/<pkg>/` 之后**层数变了**，固定 `..` 会指错。
 *
 * @param startDir - 起始目录。
 * @returns `{ path, config }`；找不到返回 null。
 */
function findInstallConfig(startDir) {
  let dir = resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, INSTALL_CONFIG_FILENAME)
    if (existsSync(candidate)) {
      try {
        const config = JSON.parse(readFileSync(candidate, 'utf8'))
        if (config !== null && typeof config === 'object') return { path: candidate, config }
      } catch {
        /* 坏 JSON 就继续往上找：一个坏文件不该让它彻底找不到家 */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 读到的那份安装配置（给诊断与其它插件用）。
 *
 * @returns `{ path, config }`；没找到返回 null。
 */
export function installConfig() {
  return findInstallConfig(HERE)
}

/**
 * 从某个目录往上找仓库根（没有配置文件时的兜底）。
 *
 * @param startDir - 起始目录。
 * @returns 仓库根绝对路径；找不到返回 null。
 */
function findRepoRoot(startDir) {
  let dir = resolve(startDir)
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg?.name === REPO_MARKER_NAME) return dir
      } catch {
        /* 坏 JSON 就继续往上找 */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 取一个非空字符串字段（配置文件里的值可能是空格、也可能不是字符串）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 把配置里的路径解析成绝对路径。
 *
 * ⚠ **相对路径以配置文件自己所在的目录为基准**（2026-10-14，为"别人 clone 后可对接"）：
 * 于是仓库根那份 `lh-install.json` 可以写 `"repo_root": "."`——跟着仓库走，
 * 不用在每台机器上改。绝对路径照旧原样使用。
 * 不这样做的后果是静默指错：`resolve('D:\\...')` 在别的机器/系统上
 * 会解析出一个"看起来像路径"的垃圾值，然后数据写进一个没人找得到的地方。
 *
 * @param value - 配置里的路径值。
 * @param configDir - 配置文件所在目录。
 * @returns 绝对路径。
 */
function resolveConfigPath(value, configDir) {
  return resolve(configDir, value)
}

/**
 * LH 的数据目录。
 *
 * @returns 绝对路径。
 * @throws 当既没有环境变量、也没有配置、也找不到仓库根时（**不猜默认值**）。
 */
export function dataDir() {
  const fromEnv = nonEmptyString(process.env.LH_DATA_DIR)
  if (fromEnv !== null) return resolve(fromEnv)

  const found = findInstallConfig(HERE)
  if (found !== null) {
    const configDir = dirname(found.path)
    const explicit = nonEmptyString(found.config.data_dir)
    if (explicit !== null) return resolveConfigPath(explicit, configDir)
    const root = nonEmptyString(found.config.repo_root)
    if (root !== null) return join(resolveConfigPath(root, configDir), 'data')
  }

  const root = findRepoRoot(HERE)
  if (root !== null) return join(root, 'data')

  throw new Error(
    'lh-paths: 找不到 LH 的数据目录。往上找了 `' + INSTALL_CONFIG_FILENAME + '`，也找了 name === "lh-workspace" 的 package.json，都没有。\n' +
      '  三种修法：\n' +
      '    1. 设环境变量 LH_DATA_DIR 指向数据目录；\n' +
      `    2. 在本包上方某一级放一个 ${INSTALL_CONFIG_FILENAME}，内容形如 {"repo_root": "<LH 仓库的绝对路径>"}；\n` +
      '    3. 若是安装到 profile 的副本，跑 `node scripts/sync-lh-deps.mjs`（它会把配置文件写进去）。\n' +
      '  **刻意不猜一个默认值**——猜错会在意想不到的位置静默建目录、写数据。',
  )
}

/**
 * 数据目录下的一个文件路径。
 *
 * @param name - 文件名（如 `model-tiers.json`）。
 * @returns 绝对路径。
 */
export function dataFile(name) {
  return join(dataDir(), name)
}

/**
 * 学习者的**工作区**（内含 `lh-questions/` 的那个目录）。
 *
 * ═══ 为什么这个函数不抛错 ═══
 * "没有工作区"不是系统级故障，是**还没配置**。原先的实现直接抛错，
 * 而它的调用点（`lh-practice` 的 `apply`）在插件装载期——
 * 于是"忘了配工作区"的后果是**整棵插件树加载失败、dsh 起不来**。
 *
 * 那和这条规则的本意（"宁可响亮地失败，也不要静默读错目录"）并不矛盾，
 * 但实现方式选错了代价：学习者被困在一个起不来的界面里，
 * 连"该设哪个变量"这句话都看不到。**响亮应该是看得见的响亮，不是把门锁上。**
 *
 * 所以这里只负责回答"能不能确定"，不确定就返回 null，由**用到它的地方**
 * 决定怎么响亮地拒绝（面板返回 503 + 说明；工具返回错误）。
 *
 * @returns `{ dir, source }`；source 说明值是从哪来的（诊断用）。不确定时返回 null。
 */
export function workspaceDir() {
  const fromEnv = nonEmptyString(process.env.LH_WORKSPACE)
  if (fromEnv !== null) return { dir: resolve(fromEnv), source: 'LH_WORKSPACE 环境变量' }

  const found = findInstallConfig(HERE)
  if (found !== null) {
    const value = nonEmptyString(found.config.workspace)
    if (value !== null) return { dir: resolveConfigPath(value, dirname(found.path)), source: `${INSTALL_CONFIG_FILENAME} (${found.path})` }
  }

  return null
}
