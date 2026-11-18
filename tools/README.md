# 测试工具（无人值守验证）

三个脚本均通过真实 WebSocket 服务器与 headless Chrome 驱动，验证局域网联机的客机画面收敛。
先启动服务器：`PORT=3123 node ../server.js`，然后按需运行：

| 脚本 | 作用 | 时长 |
|:---|:---|:---|
| `test-relay.mjs` | 纯协议层回归：验证 `state` 快照（含 `sub` 子阶段、`evts` 事件、`stage`）被原样转发给客机、`cmd` 双向透传、客机伪造 state 不会回灌。无需浏览器。 | ~5s |
| `test-smoke.mjs` | 本地/AI/必杀展示模式冒烟，抓 `window.__errors`，确认重构未破坏非联机路径。 | ~40s |
| `e2e-nettest.mjs` | 双 headless Chrome 主客机联机全流程断言：intro/live/koSlow/roundend 子阶段镜像、KO 姿态与相机聚焦、多回合残留清理、舞台一致、结算界面、重赛/返回菜单收敛（24 项）。 | ~3min |
| `shoot-net.mjs` | 在各关键节点同时截取主客机画面对照图到 `shots/`（该目录被 .gitignore 忽略）。 | ~2min |

环境约定：
- 依赖 `ws`（已在 package.json 中）；Chrome 通过 CDP 调试端口驱动，`user-data-dir` 必须位于真实用户目录（沙箱重定向后的 `USERPROFILE`），否则 Chrome 157 拒绝开启调试端口。
- 退出浏览器使用 CDP `Browser.close`，不按进程名全局结束 Chrome。
- 复用 URL 调试参数：`?lan=1&pick=N&auto=1`（自动匹配、自动选人、客机自动驾驶上行输入）。
