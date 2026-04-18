package com.genouka.remotelinker.utils

import android.content.Context
import android.content.SharedPreferences
import android.webkit.CookieManager
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.TimeUnit

/**
 * 华为OAuth认证工具大类
 * 整合：本地HTTP服务器 + API客户端 + 认证状态管理 + 数据持久化
 */
class HuaweiOAuthKit private constructor(private val context: Context) {

    companion object {
        private const val TAG = "HuaweiOAuthKit"
        private const val PREFS_NAME = "huawei_oauth_prefs"
        private const val KEY_USER_INFO = "user_info"
        private const val KEY_AUTH_STATUS = "auth_status"

        private const val OAUTH_PORT = 9527
        private const val OAUTH_TIMEOUT_MS = 180000L // 3分钟
        private const val CLIENT_TIMEOUT_MS = 30000L // 30秒

        private const val API_BASE_AUTH = "https://cn.devecostudio.huawei.com/authrouter"
        private const val DEFAULT_APP_ID = "9527"
        private const val DEFAULT_VERSION = "0.0.0"
        private const val REQUEST_TIMEOUT_MS = 15000L

        @Volatile
        private var instance: HuaweiOAuthKit? = null

        fun getInstance(context: Context): HuaweiOAuthKit {
            return instance ?: synchronized(this) {
                instance ?: HuaweiOAuthKit(context.applicationContext).also { instance = it }
            }
        }
    }

    // ==================== 类型定义 ====================

    /**
     * 认证状态
     */
    enum class AuthStatus {
        LOGGED_OUT,      // 未登录
        CHECKING,        // 检查中
        LOGGING_IN,      // 登录中
        LOGGED_IN,       // 已登录
        LOGIN_FAILED,    // 登录失败
        TOKEN_EXPIRED    // Token过期
    }

    /**
     * 用户信息
     */
    data class AuthUserInfo(
        val userId: String,
        val jwtToken: String,
        val accessToken: String,
        val name: String = "",
        val nickName: String = "",
        val displayName: String = "",
        val headPictureURL: String = "",
        val nationalCode: String = "",
        val realName: Boolean = false
    )

    /**
     * 通用响应
     */
    data class ApiResponse<T>(
        val success: Boolean,
        val data: T? = null,
        val error: String? = null
    )

    /**
     * OAuth回调结果
     */
    data class OAuthCallbackResult(
        val success: Boolean,
        val tempToken: String? = null,
        val error: String? = null
    )

    // ==================== 状态管理 ====================

    private val _authStatus = MutableStateFlow(AuthStatus.LOGGED_OUT)
    val authStatus: StateFlow<AuthStatus> = _authStatus

    private val _userInfo = MutableStateFlow<AuthUserInfo?>(null)
    val userInfo: StateFlow<AuthUserInfo?> = _userInfo

    private val _authStatusLive = MutableLiveData(AuthStatus.LOGGED_OUT)
    val authStatusLive: LiveData<AuthStatus> = _authStatusLive

    private val _userInfoLive = MutableLiveData<AuthUserInfo?>(null)
    val userInfoLive: LiveData<AuthUserInfo?> = _userInfoLive

    val isLoggedIn: Boolean
        get() = _authStatus.value == AuthStatus.LOGGED_IN && _userInfo.value != null

    val isChecking: Boolean
        get() = _authStatus.value == AuthStatus.CHECKING

    val displayName: String
        get() = _userInfo.value?.let {
            it.displayName.takeIf { it.isNotEmpty() }
                ?: it.nickName.takeIf { it.isNotEmpty() }
                ?: it.name
        } ?: ""

    // ==================== 数据持久化 ====================

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    // ==================== HTTP客户端 ====================

    private val okHttpClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(REQUEST_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .build()
    }

    // ==================== 本地HTTP服务器 ====================

    private var nanoServer: OAuthNanoServer? = null
    private var oauthCallbackDeferred: CompletableDeferred<OAuthCallbackResult>? = null
    private var oauthTimeoutJob: Job? = null

    /**
     * NanoHTTPD实现的OAuth回调服务器
     */
    private inner class OAuthNanoServer(port: Int) : NanoHTTPD(port) {

        override fun serve(session: IHTTPSession): Response {
            val uri = session.uri
            val method = session.method

            return when {
                method == Method.POST && uri == "/callback" -> handleCallback(session)
                else -> newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found")
            }
        }

        private fun handleCallback(session: IHTTPSession): Response {
            return try {
                val body = HashMap<String, String>()
                session.parseBody(body)

                val tempToken = session.parms["tempToken"]
                    ?: body["tempToken"]
                    ?: extractTempTokenFromBody(body["postData"])

                if (tempToken != null) {
                    oauthCallbackDeferred?.complete(
                        OAuthCallbackResult(success = true, tempToken = tempToken)
                    )

                    val html = """
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>授权成功</title>
                            <style>
                                body { 
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                                    text-align: center; 
                                    margin-top: 100px; 
                                    background: #1A1A1A; 
                                    color: #fff;
                                }
                                .success { 
                                    color: #64BB5C; 
                                    font-size: 24px; 
                                    font-weight: bold;
                                    margin-bottom: 20px;
                                }
                                .info { 
                                    color: #909090; 
                                    margin-top: 20px;
                                    font-size: 14px;
                                }
                                .icon {
                                    font-size: 64px;
                                    margin-bottom: 20px;
                                }
                            </style>
                        </head>
                        <body>
                            <div class="icon">✓</div>
                            <div class="success">登录授权成功</div>
                            <div class="info">此页面可以关闭</div>
                        </body>
                        </html>
                    """.trimIndent()

                    newFixedLengthResponse(Response.Status.OK, "text/html", html)
                } else {
                    oauthCallbackDeferred?.complete(
                        OAuthCallbackResult(success = false, error = "回调缺少 tempToken")
                    )
                    newFixedLengthResponse(Response.Status.BAD_REQUEST, "text/plain", "Missing tempToken")
                }
            } catch (e: Exception) {
                oauthCallbackDeferred?.complete(
                    OAuthCallbackResult(success = false, error = e.message)
                )
                newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "Error")
            }
        }

        private fun extractTempTokenFromBody(postData: String?): String? {
            postData ?: return null
            return postData.split("&")
                .map { it.split("=") }
                .filter { it.size == 2 && it[0] == "tempToken" }
                .map { java.net.URLDecoder.decode(it[1], "UTF-8") }
                .firstOrNull()
        }
    }

    // ==================== 公共API ====================

    /**
     * 初始化 - 检查缓存的登录状态
     */
    suspend fun init(): Boolean = withContext(Dispatchers.IO) {
        try {
            val cachedJson = prefs.getString(KEY_USER_INFO, null)
            if (cachedJson.isNullOrEmpty()) {
                updateStatus(AuthStatus.LOGGED_OUT)
                return@withContext false
            }

            val userInfo = parseUserInfo(cachedJson)
            if (userInfo?.jwtToken.isNullOrEmpty()) {
                updateStatus(AuthStatus.LOGGED_OUT)
                return@withContext false
            }

            updateStatus(AuthStatus.CHECKING)

            // 尝试刷新token
            val refreshed = refreshAccessTokenInternal(userInfo!!)
            if (refreshed) {
                val newUserInfo = _userInfo.value
                if (newUserInfo != null) {
                    updateStatus(AuthStatus.LOGGED_IN)
                    saveUserInfo(newUserInfo)
                    true
                } else {
                    updateStatus(AuthStatus.LOGGED_OUT)
                    false
                }
            } else {
                updateStatus(AuthStatus.TOKEN_EXPIRED)
                false
            }
        } catch (e: Exception) {
            updateStatus(AuthStatus.LOGGED_OUT)
            false
        }
    }

    /**
     * 启动OAuth服务器并等待回调
     * 返回: OAuthCallbackResult
     */
    suspend fun startAndWaitForCallback(): OAuthCallbackResult = withContext(Dispatchers.IO) {
        // 停止已有服务器
        stopServer()

        oauthCallbackDeferred = CompletableDeferred()

        // 启动服务器
        nanoServer = OAuthNanoServer(OAUTH_PORT).apply {
            start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
        }

        // 设置超时
        oauthTimeoutJob = launch {
            delay(OAUTH_TIMEOUT_MS)
            oauthCallbackDeferred?.complete(
                OAuthCallbackResult(success = false, error = "授权超时，请重试")
            )
        }

        // 等待结果
        val result = oauthCallbackDeferred?.await()
            ?: OAuthCallbackResult(success = false, error = "服务器错误")

        // 清理
        oauthTimeoutJob?.cancel()
        stopServer()

        result
    }

    /**
     * 停止OAuth服务器
     */
    fun stopServer() {
        try {
            nanoServer?.stop()
        } catch (e: Exception) {
            // ignore
        }
        nanoServer = null

        if (oauthCallbackDeferred?.isActive == true) {
            oauthCallbackDeferred?.complete(
                OAuthCallbackResult(success = false, error = "用户取消登录")
            )
        }
        oauthCallbackDeferred = null
        oauthTimeoutJob?.cancel()
    }

    /**
     * 处理OAuth回调 - 交换tempToken获取用户信息
     */
    suspend fun handleOAuthCallback(tempToken: String): ApiResponse<AuthUserInfo> = withContext(Dispatchers.IO) {
        updateStatus(AuthStatus.LOGGING_IN)

        try {
            // 1. 交换tempToken获取JWT
            val jwtToken = exchangeTempToken(tempToken)
            if (jwtToken.isNullOrEmpty()) {
                updateStatus(AuthStatus.LOGGED_OUT)
                return@withContext ApiResponse(success = false, error = "获取 JWT Token 失败")
            }

            // 2. 验证JWT获取用户信息
            val userInfo = checkJwtToken(jwtToken)
            if (userInfo == null) {
                updateStatus(AuthStatus.LOGGED_OUT)
                return@withContext ApiResponse(success = false, error = "获取用户信息失败")
            }

            // 3. 更新状态并保存
            _userInfo.value = userInfo
            updateStatus(AuthStatus.LOGGED_IN)
            saveUserInfo(userInfo)

            ApiResponse(success = true, data = userInfo)
        } catch (e: Exception) {
            updateStatus(AuthStatus.LOGGED_OUT)
            ApiResponse(success = false, error = "登录处理失败: ${e.message}")
        }
    }

    /**
     * 退出登录
     */
    suspend fun logout() = withContext(Dispatchers.IO) {
        _userInfo.value = null
        updateStatus(AuthStatus.LOGGED_OUT)

        // 清除本地存储
        prefs.edit()
            .remove(KEY_USER_INFO)
            .remove(KEY_AUTH_STATUS)
            .apply()

        // 清除WebView Cookie
        withContext(Dispatchers.Main) {
            CookieManager.getInstance().removeAllCookies(null)
        }
    }

    /**
     * 刷新AccessToken
     */
    suspend fun refreshAccessToken(): Boolean = withContext(Dispatchers.IO) {
        val currentUser = _userInfo.value ?: return@withContext false
        refreshAccessTokenInternal(currentUser)
    }

    // ==================== 私有方法 ====================

    private suspend fun exchangeTempToken(tempToken: String): String? = withContext(Dispatchers.IO) {
        val url = buildString {
            append(API_BASE_AUTH)
            append("/auth/api/temptoken/check")
            append("?site=CN")
            append("&tempToken=${java.net.URLEncoder.encode(tempToken, "UTF-8")}")
            append("&appid=$DEFAULT_APP_ID")
            append("&version=$DEFAULT_VERSION")
        }

        try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", "RemoteLinker/1.0")
                .get()
                .build()

            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null

                val body = response.body?.string()?.trim() ?: return@withContext null

                // 直接返回JWT格式
                if (!body.startsWith("{")) {
                    return@withContext body
                }

                // 解析JSON
                try {
                    val json = JSONObject(body)
                    json.optString("jwtToken").takeIf { it.isNotEmpty() }
                } catch (e: Exception) {
                    body // 可能直接返回token
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun checkJwtToken(jwtToken: String): AuthUserInfo? = withContext(Dispatchers.IO) {
        val url = "$API_BASE_AUTH/auth/api/jwToken/check"

        try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", "RemoteLinker/1.0")
                .header("jwtToken", jwtToken)
                .header("refresh", "true")
                .get()
                .build()

            okHttpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@withContext null

                val body = response.body?.string() ?: return@withContext null
                val json = JSONObject(body)

                // 解析用户信息
                val userInfoObj = json.optJSONObject("userInfo") ?: json

                val userInfo = AuthUserInfo(
                    userId = userInfoObj.optString("userId").takeIf { it.isNotEmpty() }
                        ?: json.optString("userId"),
                    jwtToken = jwtToken,
                    accessToken = userInfoObj.optString("accessToken").takeIf { it.isNotEmpty() }
                        ?: json.optString("accessToken"),
                    name = userInfoObj.optString("name"),
                    nickName = userInfoObj.optString("nickName"),
                    displayName = userInfoObj.optString("displayName"),
                    headPictureURL = userInfoObj.optString("headPicUrl").takeIf { it.isNotEmpty() }
                        ?: userInfoObj.optString("headPictureURL"),
                    nationalCode = userInfoObj.optString("nationalCode"),
                    realName = userInfoObj.optBoolean("realName")
                )

                // 验证必要字段
                if (userInfo.userId.isEmpty() || userInfo.accessToken.isEmpty()) {
                    return@withContext null
                }

                userInfo
            }
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun refreshAccessTokenInternal(userInfo: AuthUserInfo): Boolean {
        val newUserInfo = checkJwtToken(userInfo.jwtToken)
        return if (newUserInfo != null) {
            _userInfo.value = newUserInfo
            true
        } else {
            false
        }
    }

    private fun updateStatus(status: AuthStatus) {
        _authStatus.value = status
        _authStatusLive.postValue(status)
    }

    private fun saveUserInfo(userInfo: AuthUserInfo) {
        prefs.edit()
            .putString(KEY_USER_INFO, userInfoToJson(userInfo))
            .putString(KEY_AUTH_STATUS, AuthStatus.LOGGED_IN.name)
            .apply()
        _userInfoLive.postValue(userInfo)
    }

    private fun parseUserInfo(json: String): AuthUserInfo? {
        return try {
            val obj = JSONObject(json)
            AuthUserInfo(
                userId = obj.getString("userId"),
                jwtToken = obj.getString("jwtToken"),
                accessToken = obj.getString("accessToken"),
                name = obj.optString("name"),
                nickName = obj.optString("nickName"),
                displayName = obj.optString("displayName"),
                headPictureURL = obj.optString("headPictureURL"),
                nationalCode = obj.optString("nationalCode"),
                realName = obj.optBoolean("realName")
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun userInfoToJson(userInfo: AuthUserInfo): String {
        return JSONObject().apply {
            put("userId", userInfo.userId)
            put("jwtToken", userInfo.jwtToken)
            put("accessToken", userInfo.accessToken)
            put("name", userInfo.name)
            put("nickName", userInfo.nickName)
            put("displayName", userInfo.displayName)
            put("headPictureURL", userInfo.headPictureURL)
            put("nationalCode", userInfo.nationalCode)
            put("realName", userInfo.realName)
        }.toString()
    }

    fun getOAuthCallbackPort(): String = "$OAUTH_PORT"
}