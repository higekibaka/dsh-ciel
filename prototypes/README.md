# 动态原型源码存档

动态 Cordis 插件的定义只活在宿主进程内存里，重启即清空。本目录在重启**之前**
把在跑原型的当前包源码落盘（响应批评者 nit：「源码在我手里」不算持久化）。

| 目录 | 插件 | 当前包 | 状态 |
|---|---|---|---|
| `step-echo-badge/` | stecho-2 | pkg-9（client） | **常驻原型，未静态化**——重启后用它重新 define+run |
| `review-plus-rubric/` | advrub-1 | pkg-5（host） | 已静态化进 bundle 0.9.0，此档仅供回放参考 |
| `advise-command/` | advcmd-1 | pkg-16（host+client） | 已静态化进 bundle 0.10.0（`08dd572`），此档仅供回放参考 |

重启后拉起看门狗：把 `step-echo-badge/client.js` 的内容作为 `code.client`
重新 `cordis_define`（idPrefix stecho）再 `cordis_run` 即可。

历史原型（annfbk 回传、advcrd 卡片）已静态化（0.7.0 / 0.8.0）且进程内定义
已随上次重启消亡，无需存档。
