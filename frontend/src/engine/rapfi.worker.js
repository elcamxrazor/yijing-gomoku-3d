/* Rapfi WASM 引擎 Worker。

   为什么统一放进 Worker：多线程构建的引擎内部会再开 pthread 子 Worker，
   主循环泵送（gomocupLoopOnce）虽然便宜，但高频 INFO 回调如果在主线程
   解析分发，遇到快棋仍可能挤占渲染帧。所以无论引擎是单线程还是多线程
   构建，协议解析都留在这个 Worker 里，主线程只收结构化事件。

   协议与封装方式参考 Rapfi 官方的 Gomocalc（tools/rapfi/Gomocalc/src/ai/）：
   - 引擎模块是 Emscripten MODULARIZE 产物，`--pre-js preamble.js` 把
     stdin/stdout 重定向成 sendCommand / onReceiveStdout 回调；
   - 多线程构建需要传入共享的 WebAssembly.Memory（主线程探测好容量再传来），
     单线程构建让 Emscripten 自己分配即可。 */

var instance = null

function locateFile(url, engineDirURL) {
  // NNUE 权重数据文件统一命名为 rapfi.data（多套网络时按规则改名，见 main 侧）
  if (/^rapfi.*\.data$/.test(url)) url = 'rapfi.data'
  return engineDirURL + url
}

self.onmessage = function (e) {
  var msg = e.data
  if (msg.type === 'command') {
    if (instance) instance.sendCommand(msg.data)
    else console.error('[rapfi-worker] command before load:', msg.data)
    return
  }
  if (msg.type === 'load') {
    try {
      self.importScripts(msg.url)
      var dirURL = msg.url.substring(0, msg.url.lastIndexOf('/') + 1)
      self.Rapfi({
        locateFile: function (url) {
          return locateFile(url, dirURL)
        },
        onReceiveStdout: function (line) {
          self.postMessage({ type: 'stdout', line: line })
        },
        onReceiveStderr: function (line) {
          self.postMessage({ type: 'stderr', line: line })
        },
        onExit: function (code) {
          self.postMessage({ type: 'exit', code: code })
        },
        setStatus: function (text) {
          self.postMessage({ type: 'status', text: text })
        },
        wasmMemory: msg.sharedMemory || undefined,
      }).then(function (mod) {
        instance = mod
        self.postMessage({ type: 'ready' })
      })
    } catch (err) {
      self.postMessage({ type: 'fatal', message: String(err && err.message ? err.message : err) })
    }
    return
  }
  console.error('[rapfi-worker] unknown message:', msg)
}
