# 阶段0调研：系统托盘多供应商API配额仪表盘 — GitHub现成工具调研

> 调研日期：2026-08-04 | 数据来源：GitHub Search API（经代理 http://127.0.0.1:7897）| 目标：聚合 DeepSeek API余额 + OpenRouter credits + OpenCode Go套餐额度，Windows系统托盘常驻。
> 全部数据为真实抓取。限流情况：5组搜索均一次成功，无403/429。

---

## 0. 核心结论（TL;DR）

- **没有现成的"DeepSeek + OpenRouter + OpenCode Go 三合一 + Windows系统托盘"工具。** 三个数据源分散在三类repo里，各做各的。
- **OpenCode Go 没有公开配额API**，所有做它的repo都是**爬取登录态dashboard**（`https://opencode.ai/workspace/{workspaceId}/go` + `Cookie: auth=...`），从SolidJS SSR数据里正则抠 `usagePercent`/`resetInSec`。这是本项目技术含量最高的部分。
- **最值得直接复用/克隆的底座**：`FranzoiDev/ai-usagebar-win`（C#/.NET WPF，3★，MIT）—— Windows原生托盘 + 多供应商（Claude/GPT/GLM/OpenRouter/DeepSeek）架构与目标完全同构，只缺OpenCode Go。
- **数据源方案全部已实测确认**（见第3节精确endpoint与字段名）。

---

## 1. 各组关键词候选表

### 组1：deepseek balance（total_count=266）

| full_name | stars | 语言 | 许可证 | description（摘要） | 能否复用/借鉴/自研 |
|---|---|---|---|---|---|
| looplj/axonhub | 4859 | Go | NOASSERTION | 开源AI网关，100+ LLM，failover/负载均衡/成本控制 | 借鉴（成本控制思路，太重不直接复用） |
| **Joyi-code/DeepSeekMonitorWindows** | 364 | TypeScript | MIT | **Windows桌面版DeepSeek余额与用量监控**，Tauri+React+Rust | 复用（DeepSeek余额桌面展示，端点可抄） |
| atopos31/llmio | 315 | TypeScript | MIT | 统一LLM网关，负载均衡/可观测/费用追踪 | 借鉴（网关，非余额） |
| pukpuklouis/DarkForest-Hunter-OpenAI | 31 | Python | MIT | 多供应商API key猎手（DeepSeek/OpenAI/OpenRouter）扫GitHub找泄露key并验证余额 | 借鉴（批量验证余额的HTTP写法） |
| **SrtaEstrella/DeepSeekBalanceMonitor** | 17 | Rust(实为Python webview) | None | **Windows系统托盘应用**，周期查DeepSeek余额、动态托盘图标、低余额告警 | 借鉴（**托盘+DeepSeek单供应商，与本项目形态最接近**；无license慎抄代码，可借鉴结构） |
| p9966/go-deepseek | 10 | Go | MIT | DeepSeek兼容API Go客户端，含balance查询 | 复用（balance查询的Go实现） |
| legend80s/deepseek-balance-statusline | 6 | TypeScript | MIT | Claude Code状态栏实时DeepSeek余额 | 复用（**balance.ts极简，endpoint/字段完整**） |
| Hoanha2101/llmgateway-litellm | 8 | Python | None | LiteLLM网关统一多LLM提供商+成本追踪 | 借鉴 |
| guyoung/boxagnts | 9 | JavaScript | MIT | Rust AI Agent工具箱 | 不相关 |
| keiskeies/ai-gateway | 6 | Rust | None | 跨平台AI API聚合与负载均衡 | 不相关 |

### 组2：openrouter credits（total_count=81）

| full_name | stars | 语言 | 许可证 | description（摘要） | 能否复用/借鉴/自研 |
|---|---|---|---|---|---|
| dulaiduwang003/comfyui-openrouter-ai | 771 | Vue | Apache-2.0 | ComfyUI一体化管理平台，含积分用户系统 | 不相关（自建积分体系，非查询OpenRouter余额） |
| **akitaonrails/ai-usagebar** | 247 | Rust | MIT | waybar/macOS菜单栏组件：Claude/GPT/GLM/OpenRouter计划与credits监控 | 复用（OpenRouter credits查询逻辑成熟） |
| **kittizz/OpenRouterCreditMenuBar** | 22 | Swift | MIT | macOS菜单栏OpenRouter credits实时监控 | 复用（**`/api/v1/credits`端点验证最干净**） |
| pacocartones/free-llm-api-hub | 15 | JavaScript | MIT | 免费/trial LLM API数据集 | 不相关 |
| **FranzoiDev/ai-usagebar-win** | 3 | C# | MIT | **Windows原生菜单栏app**：Claude/GPT/GLM/OpenRouter/**DeepSeek**计划/credits用量 | **复用（架构与目标同构，见第4节）** |
| alphaparkinc/genpark-openrouter-spending-limit-guard-skill | 9 | Python | None | OpenRouter消费限额管理skill | 借鉴 |
| FranzoiDev/ai-usagebar-macos | 3 | Swift | MIT | 上述的macOS版前端 | 借鉴 |
| Atemndobs/hermes-plugin-credits | 2 | Python | NOASSERTION | Hermes Agent面板插件：多供应商credit/quota组件(OpenRouter/Anthropic/OpenAI/Codex) | 借鉴 |
| ZarpAIbot/openrouter-usage | 2 | Python | MIT | OpenClaw skill跟踪OpenRouter支出（余额+按模型成本） | 借鉴 |
| Krushnaapatil/free-llm-api-resources | 3 | Python | None | 免费LLM API资源列表 | 不相关 |

### 组3：opencode usage（total_count=510）

| full_name | stars | 语言 | 许可证 | description（摘要） | 能否复用/借鉴/自研 |
|---|---|---|---|---|---|
| junhoyeo/tokscale | 4769 | Rust | MIT | 终端跟踪AI编码agent的token用量+全局排行榜 | 借鉴（token统计，非套餐额度） |
| Opencode-DCP/opencode-dynamic-context-pruning | 3864 | TypeScript | AGPL-3.0 | OpenCode动态上下文裁剪插件 | 不相关 |
| Soju06/codex-lb | 2574 | Python | MIT | Codex多账号负载均衡+用量跟踪+面板 | 借鉴 |
| Javis603/token-monitor | 1118 | JavaScript | MIT | 28+ AI工具(含OpenCode)token/成本/限额本地桌面组件 | 借鉴（多工具聚合的桌面形态） |
| **slkiser/opencode-quota** | 809 | TypeScript | MIT | **OpenCode配额与token用量，零上下文污染；支持OpenCode Go/Cursor/Copilot/OpenAI/Kimi等** | **复用（OpenCode Go配额查询最成熟，见第4节）** |
| Shlomob/ocmonitor-share | 364 | Python | MIT | OpenCode用量监控CLI | 借鉴 |
| opgginc/opencode-bar | 298 | Swift | MIT | OpenCode token用量macOS菜单栏 | 借鉴（菜单栏形态） |
| ramtinJ95/opencode-tokenscope | 263 | TypeScript | MIT | OpenCode会话token分析与成本 | 借鉴 |
| jerrywu001/cc-sessions-viewer | 260 | TypeScript | None | cc/codex/antigravity/opencode会话查看器+token统计 | 不相关 |
| Nanako0129/TokenBar | 220 | Rust | MIT | macOS菜单栏AI token用量&配额监控，支持OpenCode等25+ agent | 借鉴 |

### 组4：api quota dashboard（total_count=79）

| full_name | stars | 语言 | 许可证 | description（摘要） | 能否复用/借鉴/自研 |
|---|---|---|---|---|---|
| **onllm-dev/onWatch** | 692 | Go | GPL-3.0 | **实时跟踪多个AI API配额**（Synthetic/Z.ai/Anthropic/Codex/Copilot/Antigravity），轻量后台daemon+SQLite+Material dashboard | **复用数据源（DeepSeek/OpenRouter/OpenCode全有客户端；GPL-3.0注意）** |
| zihenghe04/CCDash | 70 | Python | MIT | 开源Claude统一用量面板（Code/API/配额/成本） | 借鉴 |
| uditgoenka/indexer | 26 | TypeScript | MIT | Google Indexing API批量提交+配额跟踪 | 不相关 |
| DatanoiseTV/aigateway | 13 | Go | None | 自托管AI网关，限流/配额/模型白名单+实时面板 | 借鉴（网关配额） |
| ludengz/claude-usage-dashboard | 8 | JavaScript | ISC | Claude Code订阅用量/API成本/配额利用率面板 | 借鉴 |
| noamdorr/quotacanary-oss | 3 | TypeScript | MIT | 开源credit余额面板（针对scraping类API供应商） | 借鉴（多供应商适配器模式） |
| Zevin-Li/sub2api-quota-dashboard-sidecar | 4 | HTML | MIT | sub2api账号额度统计嵌入式页面 | 借鉴 |
| 其余 | - | - | - | 与主题无关 | 不相关 |

### 组5：system tray python（total_count=419）

| full_name | stars | 语言 | 许可证 | description（摘要） | 能否复用/借鉴/自研 |
|---|---|---|---|---|---|
| dglent/meteo-qt | 90 | Python | GPL-3.0 | 天气系统托盘应用 | 借鉴（托盘基础形态） |
| shirokumacode/overwatch-omnic-rewards | 72 | Python | GPL-3.0 | 游戏奖励系统托盘app | 不相关 |
| 7gxycn08/WSA-Tray-Helper | 34 | Python | Apache-2.0 | WSA启停监控托盘 | 借鉴 |
| anaynayak/buildnotify | 31 | Python | NOASSERTION | cctray构建状态托盘通知 | 借鉴 |
| visiuun/VMacropad | 26 | Python | MIT | 宏键盘驱动+系统托盘支持 | 不相关 |
| **StaticB1/claude_ai_usage_widget** | 21 | Python | MIT | **Claude Code系统托盘实时用量组件(5h/7d计划限额)+token/成本分析** | **复用（Python托盘+用量组件，单文件28000字节，形态最接近）** |
| Taxperia/TaxClip | 16 | Python | NOASSERTION | Windows剪贴板管理器+托盘 | 不相关 |
| j4321/MyNotes | 12 | Python | GPL-3.0 | Linux便签托盘app | 不相关 |

---

## 2. 重点：是否有"多供应商API额度聚合 + 托盘"现成工具？

**结论：没有完全一致的，但有三个非常接近的，组合后即可覆盖全部需求。**

逐一比对：

### 2.1 架构同构度最高（缺OpenCode Go）→ FranzoiDev/ai-usagebar-win（3★, C#）
- **形态**：Windows原生托盘/菜单栏app，Poller定时轮询 → 各Vendor实现 → 托盘图标渲染（`TrayService.cs` + `TrayIconFactory.cs` + `Renderer.cs`）。
- **覆盖供应商**：Anthropic / OpenAI / GLM(Z.ai) / **OpenRouter** / **DeepSeek**（`Services/Vendors/` 下每供应商一个类）。
- **缺**：OpenCode Go。
- **评价**：与本项目"Windows托盘 + 多供应商聚合"的架构**完全同构**，MIT可安全克隆。是直接改造的最佳底座（C#/.NET WPF路线）。

### 2.2 聚合引擎最全（但非托盘）→ onllm-dev/onWatch（692★, Go, GPL-3.0）
- **形态**：后台daemon（<50MB RAM）+ SQLite + Material Design 3 web dashboard + GNOME/macOS menubar扩展。**不是Windows系统托盘**。
- **数据源覆盖**：**DeepSeek、OpenRouter、OpenCode Go、Claude/Codex/Copilot/Cursor/Gemini/Kimi/Moonshot/Z.ai等一应俱全**（`internal/api/` 下每供应商一个client）。
- **数据源方案质量**：目前GitHub上对三目标供应商最完整的参考实现——DeepSeek余额、OpenRouter credits/用量、OpenCode Go dashboard爬取全都有现成Go代码和测试。
- **注意**：**GPL-3.0**（强copyleft）。直接抄代码会让项目变成GPL；**借鉴逻辑/端点则可**。
- **评价**：最佳"数据源教科书"，适合照抄API交互逻辑到自研语言，不适合整库复用。

### 2.3 OpenCode Go配额引擎最成熟 → slkiser/opencode-quota（809★, TypeScript, MIT）
- **形态**：OpenCode插件 + CLI，把配额状态渲染成对话内toast/statusline，**不是桌面托盘**。
- **覆盖**：OpenCode Go / Cursor / Copilot / OpenAI / Alibaba / Kimi / GLM / Z.ai / Qwen / MiniMax等，`src/providers/` 每供应商一个provider，`src/lib/quota-providers-remote.ts`(26KB)+`quota-providers.ts`(53KB)是通用配额引擎。
- **OpenCode Go实现**：`src/providers/opencode-go.ts` + `src/lib/opencode-go.ts`，与onWatch同思路（dashboard爬取），且更精细（5h/weekly/monthly三窗口、SSR+data-slot双解析、reset时间人类可读解析）。
- **评价**：OpenCode Go配额查询的**最成熟实现**，MIT可安全参考/移植。

### 2.4 单供应商托盘样板 → SrtaEstrella/DeepSeekBalanceMonitor（17★, 无license）
- **形态**：Windows系统托盘 + 周期查DeepSeek余额 + 动态托盘图标 + 低余额告警（`src/tray_app.py` 19KB）。单供应商。
- **评价**：Python托盘写法的现成样板（webview+托盘），但**无license**，只能借鉴结构不能抄代码。

### 2.5 单文件Python托盘用量组件 → StaticB1/claude_ai_usage_widget（21★, MIT）
- **形态**：单文件(28KB) Python，Claude Code系统托盘实时用量组件 + 本地token/成本分析。
- **评价**：Python托盘+额度轮询的最小完整示例，MIT可安全参考。

---

## 3. 数据源方案要点（全部实测，非猜测）

### 3.1 DeepSeek API余额

**Endpoint（4个独立repo实测一致）：**
```
GET https://api.deepseek.com/user/balance
Headers: Authorization: Bearer <API_KEY>
         Accept: application/json
```

**返回字段（实测，值类型为string）：**
```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",              // "CNY" 或 "USD"
      "total_balance": "12.34",       // 总余额
      "granted_balance": "1.00",      // 赠送余额
      "topped_up_balance": "11.34"    // 充值余额
    }
  ]
}
```
- 实际可用余额 = `total_balance`（或 granted + topped_up）。
- 多币种时按需选 CNY 优先（onWatch源码注释：`Priority: CNY over USD if multiple`；ai-usagebar-win 则优先取 USD）。
- 401 = key无效。
- 出处：`onllm-dev/onWatch/internal/api/deepseek_types.go`；`SrtaEstrella/DeepSeekBalanceMonitor/src/api_client.py`；`legend80s/deepseek-balance-statusline/utils/balance.ts`；`FranzoiDev/ai-usagebar-win/AiUsageBar/Services/Vendors/DeepseekVendor.cs`。

### 3.2 OpenRouter credits

**两个端点，互补使用（全部实测）：**

**① 余额端点（总credits - 已用）：**
```
GET https://openrouter.ai/api/v1/credits
Headers: Authorization: Bearer <API_KEY>
```
返回（实测）：
```json
{ "data": { "total_credits": 10.0, "total_usage": 2.5 } }
```
- **剩余 = total_credits - total_usage**（Kittizz 的 Swift 代码里正是这么算的：`currentCredit = creditData.total_credits - creditData.total_usage`）。
- 出处：`kittizz/OpenRouterCreditMenuBar/OpenRouterCreditManager.swift`；`FranzoiDev/ai-usagebar-win/.../OpenRouterVendor.cs`。

**② 用量/限额端点（含日/周/月用量与额度上限）：**
```
GET https://openrouter.ai/api/v1/auth/key
```
返回（onWatch实测解析）：
```json
{ "data": {
    "label": "...",
    "usage": 2.5,            // 累计用量(USD)
    "limit": 10.0,           // 充值额度上限，可null
    "limit_remaining": 7.5,  // 剩余额度，可null
    "is_free_tier": false,
    "usage_daily": 0.0,
    "usage_weekly": 0.0,
    "usage_monthly": 0.0,
    "rate_limit": { "requests": 1000, "interval": "daily" }
} }
```
- 注意字段名是 `usage`/`limit`/`limit_remaining`，**不是** `credits_used`/`credits_left`。
- 变体：ai-usagebar-win 用的是 `https://openrouter.ai/api/v1/key`（少`auth/`段），实测同结构——说明两路径都可用，官方文档为 `/api/v1/auth/key`。
- 出处：`onllm-dev/onWatch/internal/api/openrouter_types.go` + `openrouter_client.go`。

### 3.3 OpenCode Go 套餐用量

**没有公开配额API。** 两个做这个的repo（onWatch、opencode-quota）均为**爬取登录态dashboard**：

```
GET https://opencode.ai/workspace/{workspaceId}/go
Headers: Cookie: auth=<浏览器auth cookie值>
         User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0
```

**解析方式（两种格式，按顺序fallback）：**
1. **SolidJS SSR hydration**：在HTML里正则匹配
   `rollingUsage:$R[\d]+={[^}]*usagePercent:<数字>[^}]*resetInSec:<数字>[^}]*}`（以及 `weeklyUsage` / `monthlyUsage`；字段顺序会变，需同时匹配两种顺序）。
2. **新data-slot格式**：`data-slot="usage-item"` 内取 `data-slot="usage-label">`（Rolling/Weekly/Monthly Usage）与 `data-slot="usage-value">`（百分比）及 reset 时间（"Resets in X hours Y minutes"，解析成秒）。

**三窗口**：rolling(≈5小时) / weekly(周) / monthly(月)，字段为 `usagePercent`(已用%) + `resetInSec`(重置倒计时秒)。

**认证来源（opencode-quota实测）：**
- 配置方式A：环境变量 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE`。
- 配置方式B：JSON文件 `<opencode config dir>/opencode-quota/opencode-go.json` 内 `{"workspaceId":"wrk_...","authCookie":"..."}`。
- workspaceId 获取：浏览器打开 dashboard 后 URL 里的 `wrk_...` 段；或用 `Cookie: auth=...` 请求 `https://opencode.ai/go` 后 `grep -oE 'wrk_[A-Za-z0-9]+'` 发现。
- auth cookie 获取：登录 opencode.ai 后 DevTools → Application → Cookies → 复制 `auth` cookie 值（有效期随会话，过期需重抓）。

**关于Agy公开API**：onWatch测试数据 `internal/api/testdata/agy_quota_summary.json` 显示底层存在一个公开JSON结构 `{"response":{"groups":[{displayName,description,buckets:[{bucketId:"gemini-weekly"/"gemini-5h"/"3p-weekly"/"3p-5h",displayName,window:"weekly"/"5h",remainingFraction,resetTime}]}]}}`——即 Cline/Agy workspace 配额接口。但**现有工具都未走它**，稳定性未知，建议仍走dashboard爬取。

---

## 4. 复用建议

### 直接复用（选底座改）
1. **FranzoiDev/ai-usagebar-win（3★, C#/.NET WPF, MIT）** —— 首选底座。理由：Windows原生托盘 + 多供应商Poller架构 + 托盘图标渲染 + 已有DeepSeek/OpenRouter实现，与本项目"Windows托盘多供应商仪表盘"**同构**，只缺OpenCode Go；MIT可自由改。改造量最小。
2. **slkiser/opencode-quota（809★, TypeScript, MIT）** —— OpenCode Go配额引擎直接移植。理由：最成熟的OpenCode Go查询（双格式解析+三窗口+认证配置），且有完整测试。

### 仅借鉴数据源（不整库复用）
- **onllm-dev/onWatch（692★, Go, GPL-3.0）** —— 三目标供应商的API交互逻辑最全最规范，**但GPL-3.0**：整段照抄会传染许可证。**建议作为端点/字段/错误处理的参考书**，用自己的语言重写。
- **akitaonrails/ai-usagebar（247★, Rust, MIT）** —— OpenRouter/Claude/GLM credits查询思路（若走Rust路线）。
- **kittizz/OpenRouterCreditMenuBar（22★, Swift, MIT）** —— `/api/v1/credits` 端点最小验证示例。
- **Joyi-code/DeepSeekMonitorWindows（364★, TypeScript, MIT）** —— DeepSeek余额+用量的Windows桌面实现。
- **legend80s/deepseek-balance-statusline（6★, TypeScript, MIT）** —— 极简DeepSeek余额查询（`utils/balance.ts`仅2.8KB，可直接读）。
- **StaticB1/claude_ai_usage_widget（21★, Python, MIT）** —— 若走Python路线，单文件托盘+用量组件的完整参考。

### 自研（无现成，必须写）
- **三合一聚合层 + Windows系统托盘 UI**：没有任何现成工具同时做到"DeepSeek余额 + OpenRouter credits + OpenCode Go套餐额度"三合一且常驻Windows托盘。需自行组合：
  - 数据获取 = 3.1/3.2/3.3 三个已实测端点；
  - 托盘渲染 = Python `pystray`/`PIL`（参考 SrtaEstrella 的 tray_app.py 结构）或直接改 ai-usagebar-win 的 `Renderer.cs`；
  - OpenCode Go认证管理 = 引导用户粘贴 workspaceId + auth cookie（参考 onWatch `docs/OPENCODE_SETUP.md` 的步骤）。
- **许可证建议**：目标项目若想保持宽松许可，只参考 onWatch 的**逻辑**（GPL-3.0），可安全照抄MIT/无争议代码（ai-usagebar-win/opencode-quota/kittizz 均MIT）。

---

## 附录：实际抓取到的仓库许可证速查

| repo | license | 是否可安全复用代码 |
|---|---|---|
| FranzoiDev/ai-usagebar-win | MIT | ✅ |
| slkiser/opencode-quota | MIT | ✅ |
| akitaonrails/ai-usagebar | MIT | ✅ |
| kittizz/OpenRouterCreditMenuBar | MIT | ✅ |
| Joyi-code/DeepSeekMonitorWindows | MIT | ✅ |
| legend80s/deepseek-balance-statusline | MIT | ✅ |
| p9966/go-deepseek | MIT | ✅ |
| StaticB1/claude_ai_usage_widget | MIT | ✅ |
| onllm-dev/onWatch | GPL-3.0 | ⚠️ 仅借鉴逻辑 |
| SrtaEstrella/DeepSeekBalanceMonitor | None | ⚠️ 无许可证，仅借鉴结构 |
