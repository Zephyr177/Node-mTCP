"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipeType = void 0;
exports.createPipeServer = createPipeServer;
const net_1 = require("net");
const mtcp_1 = require("./mtcp");
var PipeType;
(function (PipeType)
{
    PipeType[PipeType["tcp2mtcp"] = 0] = "tcp2mtcp";
    PipeType[PipeType["mtcp2tcp"] = 1] = "mtcp2tcp";
})(PipeType || (exports.PipeType = PipeType = {}));
function createPipeServer(upstream_port, upstream_host, pipe_type = PipeType.tcp2mtcp, lisent_port, poolCount = 2, //每个连接的子流个数
    preLinkCount = 0)
{
    let createServerFn = pipe_type == PipeType.tcp2mtcp ? net_1.createServer : mtcp_1.createMTcpServer;
    let connectFn = pipe_type == PipeType.tcp2mtcp ? mtcp_1.connectMTcp : net_1.connect;
    let preConnPool = []; //预连接池
    
    // <<< MODIFICATION START >>>
    // 移除了 "pipe_type === PipeType.mtcp2tcp" 的判断条件
    // 使得预连接逻辑对 tcp2mtcp (client.js) 和 mtcp2tcp (remote.js) 两种模式都生效
    if (preLinkCount > 0) {
        //预连接
        const PreConnect = () =>
        {
            if (preConnPool.length >= preLinkCount) {
                return; // 如果池已满，则不创建新连接
            }
            let conn = connectFn({ port: upstream_port, host: upstream_host }, function ()
            {
                preConnPool.push(conn);
                const remove = () =>
                {
                    let index = preConnPool.indexOf(conn);
                    if (index !== -1) {
                        preConnPool.splice(index, 1);
                        // 连接被动关闭后，立即补充一个新的预连接
                        PreConnect();
                    }
                };
                conn.on("close", remove);
                conn.on('error', () =>
                {
                    remove();
                    conn.destroy();
                });
            });
            // 为client.js (tcp2mtcp) 添加连接错误处理，以便在连接失败时重试
            conn.on('error', (err) => {
                if (preConnPool.indexOf(conn) === -1) { // 如果连接已经成功并被使用，则此错误由上层处理
                    return;
                }
                // 如果是还在池中的预备连接出错了
                let index = preConnPool.indexOf(conn);
                if (index !== -1) {
                    preConnPool.splice(index, 1);
                }
                conn.destroy();
                // 稍后尝试重新连接
                setTimeout(PreConnect, 5000); 
            });
        };

        for (let i = 0; i < preLinkCount; i++)
            setTimeout(PreConnect, i * 500); // 初始时错开时间创建连接
            
        // 每3s检查并替换一个最旧的连接，以防连接因空闲而被中间设备断开
        setInterval(() =>
        {
            if (preConnPool.length === preLinkCount) {
                let oldConn = preConnPool.shift();
                oldConn?.destroy(); // 销毁最旧的连接
                PreConnect(); // 创建一个新的连接补充到队尾
            }
        }, 3000);
    }
    // <<< MODIFICATION END >>>

    let server = createServerFn(function (conn)
    {
        if (pipe_type === PipeType.tcp2mtcp)
            mtcp_1.MSocket.PoolCount = poolCount;
        let up_socket;
        if (preConnPool.length) {
            up_socket = preConnPool.shift();
            up_socket.removeAllListeners("close");
            up_socket.removeAllListeners("error");
            up_socket.pipe(conn, { end: true });
            conn.pipe(up_socket, { end: true });
            
            // <<< ADDITION >>>
            // 当一个预连接被使用后，立即尝试补充一个新的到池中
            if (preLinkCount > 0) {
                // 稍微延迟一下，避免瞬间建立大量连接
                setTimeout(() => PreConnect(), 100);
            }
            // <<< END ADDITION >>>
        }
        else
            up_socket = connectFn({ port: upstream_port, host: upstream_host }, function ()
            {
                up_socket.pipe(conn, { end: true });
                conn.pipe(up_socket, { end: true });
            });
        const destroy = () =>
        {
            up_socket.destroySoon();
            conn.destroySoon();
        };
        conn.on('error', destroy);
        up_socket.on('error', destroy);
        conn.on('close', destroy);
        up_socket.on('close', destroy);
    });
    if (lisent_port) {
        server.listen(lisent_port, () =>
        {
            console.log(`启动成功:listen ${pipe_type === PipeType.mtcp2tcp ? "mtcp" : "tcp"}:${lisent_port} -> ${pipe_type === PipeType.mtcp2tcp ? "tcp" : "mtcp"}:${upstream_host}:${upstream_port}`);
            if (preLinkCount > 0) {
                console.log(`预连接池已启用, 数量: ${preLinkCount}`);
            }
        });
        server.on("error", (err) =>
        {
            console.log(`启动失败:listen:${lisent_port} -> ${upstream_host}:${upstream_port} err:${err.message}`);
        });
    }
    return server;
}
