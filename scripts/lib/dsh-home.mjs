/**
 * LH 的**宿主目录定位** —— 所有脚本都从这里问"dsh 的家在哪"。
 *
 * ═══ 为什么要有这个文件（2026-09-20）═══
 * 作者要把开发迁到"工作区自持"：用 `DSH_HOME` 把 dsh 的家指到工作区里的 `.dsh/`，
 * 这样任何 IDE/CLI 打开这个仓库都能完整开发，不必依赖 `~/.dsh`。
 *
 * 而当时有三个 check 脚本**写死了** `process.env.USERPROFILE/.dsh/profiles/web`：
 * 迁移之后它们会继续去读**旧目录**里的安装副本——于是
 *   · 闸门可能对着旧副本变绿（"测过了"是假的）；
 *   · 或者报"找不到 profile"（看起来像配置坏了）。
 * **闸门指着错的目录比闸门红更糟**：它会让人去修一个没坏的东西。
 *
 * 所以这里只回答一个问题，且与宿主自己的优先级一致
 * （`[宿主源码]` `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome`）：
 *
 *   显式配置 > `$DSH_HOME` > `~/.dsh`
 *   且**空白值的 `DSH_HOME` 按未设置处理**（宿主源码里明确这么写，
 *   否则一个空字符串会把"家"解析成当前工作目录）。
 *
 * ═══ 它刻意不做什么 ═══
 * 不读 `settings.yaml`、不猜 profile 名。**profile 名由调用方给**——
 * 因为"有哪些 profile"是环境事实，不是这个模块该假装知道的事。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 环境变量名（与宿主一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/** 默认目录名（与宿主一致）。 */
export const DSH_HOME_DIR_NAME = '.dsh'

/**
 * 解析 dsh 的家目录。
 *
 * 优先级与宿主一致：显式参数 > `$DSH_HOME` > `~/.dsh`。
 * **空白值按未设置处理**（照抄宿主源码的判据，见文件头）。
 *
 * @param configured - 显式给的路径（可选）。
 * @returns 绝对路径（不保证存在）。
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env[DSH_HOME_ENV]
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * dsh 家里的 `profiles` 目录。
 *
 * @param configured - 显式给的 home（可选）。
 * @returns 路径。
 */
export function profilesDir(configured) {
  return join(resolveDshHome(configured), 'profiles')
}

/**
 * 列出**真实存在**的 profile 目录（带 `node_modules/@lh` 的那些才算装了 LH）。
 *
 * @param configured - 显式给的 home（可选）。
 * @returns `[{ name, dir, lhNodeModules }]`。
 */
export function installedProfiles(configured) {
  const base = profilesDir(configured)
  if (!existsSync(base)) return []
  const out = []
  for (const name of readdirSync(base)) {
    const dir = join(base, name)
    const lhNodeModules = join(dir, 'node_modules', '@lh')
    if (existsSync(lhNodeModules)) out.push({ name, dir, lhNodeModules })
  }
  return out
}

/**
 * 打印一行"家在哪儿"，让每次脚本输出都能自证**它看的是哪个目录**。
 *
 * ═══ 为什么值得打这一行 ═══
 * 迁移期最危险的状态是"两个家并存"：脚本 A 看新家、脚本 B 看旧家，
 * 而两边都能给出结果。有了这一行，任何人（和我）读输出就知道它看的是哪个。
 *
 * @param label - 前缀（如 `check-profile-apply`）。
 * @returns 形如 `[check-x] DSH_HOME = D:\…\.dsh（来自 DSH_HOME）` 的字符串。
 */
export function describeHome(label) {
  const fromEnv = process.env[DSH_HOME_ENV]
  const explicit = typeof fromEnv === 'string' && fromEnv.trim() !== ''
  const home = resolveDshHome()
  return `${label}: DSH_HOME = ${home}（${explicit ? '来自环境变量' : '默认 ~/.dsh'}）`
}
