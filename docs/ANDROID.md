# Android 内测壳

这是给 `414398fdeb6b0e9d7d79de3d08140f9166e7100c` 做的安装壳，父提交是手测检查点 `07ec01ebd59b2e5da026b5d30582baf4f1caa11b`。没有合并 `main`，没有开云主机，没有公网地址，也没有把供应商 Key 放进应用。

装上 debug APK 只表示手机上有这个壳。它不能单独注册或聊天。聊天仍然要连到你自己的服务。服务没配 `DEEPSEEK_API_KEY` 时，发送会得到 `model_gateway_unconfigured`，不会用夹具冒充。

## 可安装和可聊天是两件事

- 可安装：debug APK，`applicationId` 是 `app.deepcompanion.shell`，`versionName` 是 `0.1.0-debug`，`versionCode` 是 1。
- 可聊天：现在没有。壳里没有预置服务器地址。USB 回环只是临时调试。将来的 HTTPS 地址要等父助手核实免费且能保存 SQLite 的宿主之后再填，本仓库不写死一个还不存在的 URL。
- 静态网站托管不能代替这个后端。页面和 `/api` 必须由现在的 Node 进程一起提供，数据在 SQLite。

## 地址怎么填

打开应用后填写服务源，不要带路径、查询或账号。

- 将来的正式地址必须是 `https://你的主机`。页面和 API 在同一个源。服务端设置 `STATIC_DIR` 指向 `web/dist`，并把 `COOKIE_SECURE=1`。TLS 在这台 Node 前面终止。证书错误不会被忽略，自签证书会打开失败。
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

云端用的是 JDK 21、Android SDK 35/36 和 Build-Tools 35/36。命令是：

```sh
npx cap sync android
cd android
./gradlew assembleDebug
```

产物在 `android/app/build/outputs/apk/debug/app-debug.apk`。debug 网络配置只允许回环和 `10.0.2.2` 的明文，系统证书以外的用户证书不信任。
