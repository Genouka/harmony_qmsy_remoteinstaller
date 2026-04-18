package com.genouka.remotelinker

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.net.toUri
import androidx.fragment.app.Fragment
import androidx.navigation.Navigation.findNavController
import com.genouka.remotelinker.databinding.FragmentLoginhuaweiBinding
import com.genouka.remotelinker.utils.HuaweiOAuthKit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch


/**
 * A simple [Fragment] subclass as the default destination in the navigation.
 */
class LoginHuaweiFragment : Fragment() {

    private lateinit var authKit: HuaweiOAuthKit
    private var _binding: FragmentLoginhuaweiBinding? = null

    // This property is only valid between onCreateView and
    // onDestroyView.
    private val binding get() = _binding!!

    val handler = Handler(Looper.getMainLooper())

    private val scope = CoroutineScope(Dispatchers.Main + Job())

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {

        _binding = FragmentLoginhuaweiBinding.inflate(inflater, container, false)
        return binding.root

    }

    fun startOAuthLogin() {
        scope.launch {
            // 1. 启动本地服务器等待回调
            val result = authKit.startAndWaitForCallback()

            if (result.success && result.tempToken != null) {
                // 2. 处理回调，获取用户信息
                val response = authKit.handleOAuthCallback(result.tempToken)

                if (response.success) {
                    handler.post {
                        binding.textViewLogger.text = "登录成功"
                        val navController = findNavController(requireView())
                        navController.previousBackStackEntry!!
                            .savedStateHandle.apply {
                                set<String?>("aid", response.data?.accessToken)
                                set<String?>("urid", response.data?.userId)
                            }
                        navController.popBackStack()
                    }
                } else {
                    handler.post {
                        binding.textViewLogger.text = "登录失败：${response.error}"
                    }
                }
            } else {
                handler.post {
                    binding.textViewLogger.text = "登录失败：${result.error ?: "未知错误"}"
                }
            }
        }

        // 3. 打开华为OAuth页面
        val oauthUrl = buildString {
            append("https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply?port=")
            append(authKit.getOAuthCallbackPort())
        }

        val intent = Intent(Intent.ACTION_VIEW, oauthUrl.toUri()).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT or
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_MULTIPLE_TASK
            )
        }
        startActivity(intent)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.buttonFirst.setOnClickListener {
            startOAuthLogin()
        }
        authKit = HuaweiOAuthKit.getInstance(requireContext())
        authKit.authStatusLive.observe(viewLifecycleOwner) { status ->
            when (status) {
                HuaweiOAuthKit.AuthStatus.LOGGED_IN -> {
                    binding.textViewLoginStatus.text = "已登录"
                }

                HuaweiOAuthKit.AuthStatus.LOGGED_OUT -> {
                    binding.textViewLoginStatus.text = "未登录"
                }

                HuaweiOAuthKit.AuthStatus.TOKEN_EXPIRED -> {
                    binding.textViewLoginStatus.text = "登录过期，请重新登录"
                }

                else -> {}
            }
        }
        authKit.userInfoLive.observe(viewLifecycleOwner) { userInfo ->
            userInfo?.let {
                binding.textViewLoginUsername.text = it.displayName
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    override fun onDestroy() {
        super.onDestroy()
        authKit.stopServer()
        scope.cancel()
    }
}