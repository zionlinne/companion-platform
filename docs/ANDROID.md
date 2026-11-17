# Android

原来的 debug APK 是开发证据，不是内测成品。普通用户不该在安装后先填服务器地址或供应商 Key。

可分发内测包由 `npm run android:trial` 检查 `COMPANION_PUBLIC_ORIGIN`。它必须是真实 HTTPS 源，不能是本机、示例或占位域名。没有这个域名时命令打印 `BLOCKED` 并以状态 2 退出，不生成安装包，也不用假地址冒充完成。通过检查之后，构建会把这个源写进 `BuildConfig.TRIAL_ORIGIN`，应用直接打开站点，没有地址按钮，也没有 Key 输入。这次内测源是 `https://deep-companion.onrender.com`。

debug 变体仍然保留地址选择器，只给开发者连本机服务。它和内测包不是同一个交付。

这是给 `414398fdeb6b0e9d7d79de3d08140f9166e7100c` 之后的部署分支写的说明，父提交是手测检查点 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b`。没有合并 `main`，没有把供应商 Key 放进应用。

服务没配 `DEEPSEEK_API_KEY` 时，发送会得到 `model_gateway_unconfigured`，不会用夹具冒充。

## 可安装和可聊天是两件事

- 可安装的 debug 包：`applicationId` 是 `app.deepcompanion.shell`，`versionName` 是 `0.1.0-debug`，`versionCode` 是 2。它没有预置地址，只给开发者连本机。
- 可安装的记忆引擎内测包：同一个应用 id，`versionName` 是 `0.1.0-memory`，`versionCode` 是 2，源锁定 `https://deep-companion.onrender.com`。WebView 打开的是这个远程源。线上进程还没部署这份服务端时，安装包里的记忆引擎不会出现在网页上。供应商 Key 不在包里。
- 这台环境没有手机或模拟器，所以没有把包装到设备上，也不能把打开网页说成已经在手机上聊天。没有供应商 Key 时，线上发送会失败，不会用夹具冒充。

## 地址怎么填

内测包不显示地址页，直接打开 `https://deep-companion.onrender.com`。下面这些只属于没有预置源的 debug 包。

- debug 包打开后填写服务源，不要带路径、查询或账号。页面和 API 在同一个源。服务端设置 `STATIC_DIR` 指向 `web/dist`，并把 `COOKIE_SECURE=1`。TLS 在这台 Node 前面终止。证书错误不会被忽略，自签证书会打开失败。
- 这个 debug 包可以临时填 `http://127.0.0.1:8787`。也允许 `http://localhost:8787` 和模拟器专用的 `http://10.0.2.2:8787`。其它 HTTP，包括局域网地址，会被拒绝。
- 正式包的清单没有这些明文例外。`android:usesCleartextTraffic` 在主清单里是 `false`。
- 地址存在应用私有的 `SharedPreferences`，只保存这一个 URL。登录会话仍是服务端原来的 `HttpOnly` Cookie `cp_session`，放在 WebView 的系统 Cookie 库里，不进 `localStorage`。更换地址会清掉这些 Cookie。右上角「地址」回到填写页。「清除本机 Cookie」也只清 Cookie 库。
- 应用备份已关闭，避免系统备份带走 Cookie。

同源之后，原来的相对路径 `fetch`、`X-Companion-Request` 和 `SameSite=Lax` 不用放宽。没有把 CORS 改成任意域，也没有启用 Capacitor 的原生 HTTP 补丁，避免把聊天的流式响应截断。

## 临时 USB

手机上的 `127.0.0.1` 是手机自己。电脑上的服务只听 `127.0.0.1:8787` 时，要用 USB 反向端口，不要改成公网监听，也不要开防火墙。

在已经包含 88API 补丁的目录里构建页面并启动。数据库目录不要换掉。

```powershell
npm run build
$env:HOST = "127.0.0.1"
$env:PORT = "8787"
$env:STATIC_DIR = "web\dist"
$env:COOKIE_SECURE = "false"
npm start
```

模型变量仍按 `docs/88API.md`。Key 只放在这台电脑的环境变量里。

手机打开开发者选项和 USB 调试后：

```powershell
adb reverse tcp:8787 tcp:8787
adb install -r deep-companion-0.1.0-debug.apk
```

然后在壳里填写 `http://127.0.0.1:8787`。没有执行 `adb reverse` 时，这个地址打不开，这不是聊天成功。拔掉 USB 或撤销 reverse 之后，临时地址就失效。

## 移动界面

安全区、键盘顶起和文件选择改在将要由服务端提供的网页里：导航避开刘海，输入栏贴着键盘，聊天附件、人格卡和记忆文本可以用系统文件选择。WebView 使用 Capacitor 自带的文件选择回调。推送没有实现，没有接入 FCM 或 APNs。

这些网页改动要随本分支的 `web/dist` 一起放到 `STATIC_DIR`。只安装 APK、服务仍提供旧页面时，看到的是旧布局。

## iOS

`ios/` 是 Capacitor 8.6.2 生成的 Xcode 工程，Info.plist 没有 `NSAllowsArbitraryLoads`。这里没有 Mac，也没有跑 `xcodebuild`，所以没有 IPA，不能把它说成已经用 Xcode 构建。地址页和 debug 明文限制目前只在 Android 壳里。

## 构建

云端用的是 JDK 21、Android SDK 35/36 和 Build-Tools 35/36。没有源时 `npm run android:trial` 只检查并退出。有真实 HTTPS 源时，它先执行 `npx cap sync android`，再执行 `./gradlew assembleDebug`，把源写进 `BuildConfig.TRIAL_ORIGIN`。

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。带内测源时 `versionName` 是 `0.1.0-memory`。debug 网络配置只允许回环和 `10.0.2.2` 的明文，系统证书以外的用户证书不信任。内测源是 HTTPS，不走这些明文例外。只安装这个包、不部署同版本服务端时，打开的仍是线上旧页面。
