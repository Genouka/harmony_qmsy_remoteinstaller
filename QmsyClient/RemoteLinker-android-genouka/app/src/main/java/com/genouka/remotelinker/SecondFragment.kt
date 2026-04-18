package com.genouka.remotelinker

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.lifecycle.Observer
import androidx.navigation.Navigation.findNavController
import androidx.navigation.fragment.findNavController
import com.genouka.remotelinker.databinding.FragmentSecondBinding
import com.genouka.remotelinker.utils.QmsyClient


/**
 * A simple [Fragment] subclass as the second destination in the navigation.
 */
class SecondFragment : Fragment() {

    private var _binding: FragmentSecondBinding? = null

    // This property is only valid between onCreateView and
    // onDestroyView.
    private val binding get() = _binding!!
    val handler = Handler(Looper.getMainLooper())
    inner class cQmsyClientCallback(): QmsyClient.MessageCallback {
        override fun onMessage(message: String?) {
            handler.post {
                binding.textViewLogger.text = buildString {
                    append(binding.textViewLogger.text.toString())
                    append(message)
                    append("\n")
                }
            }
        }

        override fun onError(error: String?) {
            handler.post {
                binding.textViewLogger.text = buildString {
                    append(binding.textViewLogger.text.toString())
                    append("[ClientErr]连接错误\n")
                    append(error ?: "")
                    append("\n")
                }
            }
        }

        override fun onConnected(port: Int) {
            handler.post {
                binding.textViewLogger.text = buildString {
                    append(binding.textViewLogger.text.toString())
                    append("[ClientCtl]已连接端口：$port")
                    append("\n")
                }
            }
        }

        override fun onDisconnected() {
            handler.post {
                binding.textViewLogger.text = buildString {
                    append(binding.textViewLogger.text.toString())
                    append("[ClientCtl]已断开连接")
                    append("\n")
                }
                binding.buttonConnect.isEnabled = true
                binding.buttonDisconnect.isEnabled = false
            }
        }
    }


    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {

        _binding = FragmentSecondBinding.inflate(inflater, container, false)
        return binding.root

    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val navController = findNavController(requireView())
        navController.currentBackStackEntry!!
            .savedStateHandle.apply {
                getLiveData<Any?>("aid").observe(getViewLifecycleOwner(), Observer { data: Any? ->
                        if (data != null) {
                            binding.editTextAid.setText(data.toString())
                        }
                    })
                getLiveData<Any?>("urid").observe(getViewLifecycleOwner(), Observer { data: Any? ->
                    if (data != null) {
                        binding.editTextUrid.setText(data.toString())
                    }
                })
            }

        val autoString: Array<String> = arrayOf<String>(
            "150.158.89.45", "scforwardservice.genouka.top", "10.162.194.131"
        )
        val adapter = ArrayAdapter<String>(
            requireContext(),
            android.R.layout.simple_dropdown_item_1line, autoString
        )
        binding.editTextProvider.setAdapter(adapter)
        var qmsyClient: QmsyClient? = null
        binding.buttonSecond.setOnClickListener {
            findNavController().navigate(R.id.action_SecondFragment_to_loginHuaweiFragment)
        }
        binding.buttonConnect.setOnClickListener {
            binding.buttonConnect.isEnabled = false
            binding.buttonDisconnect.isEnabled = true
            val tProvider = binding.editTextProvider.text.toString()
            val tAid = binding.editTextAid.text.toString()
            val tUid = binding.editTextUid.text.toString()
            val tUrid = binding.editTextUrid.text.toString()
            val tHapid = binding.editTextHapid.text.toString()
            val tPwd = binding.editTextPwd.text.toString()
            val tForwarder = binding.editTextForwarder.text.toString()
            try{
                qmsyClient = QmsyClient(tProvider, tUid, tPwd, tAid, tUrid, tHapid, tForwarder)
                qmsyClient.setCallback(cQmsyClientCallback())
                Thread{
                    qmsyClient.connect()
                }.start()
            }catch(e: Exception){
                binding.textViewLogger.text = e.toString()
            }
        }
        binding.buttonDisconnect.setOnClickListener {
            if(qmsyClient != null){
                if(qmsyClient.isRunning()){
                    Thread{
                        qmsyClient.disconnect()
                    }.start()
                }else{
                    binding.buttonDisconnect.isEnabled = false
                    binding.buttonConnect.isEnabled = true
                }
            }else{
                binding.buttonDisconnect.isEnabled = false
                binding.buttonConnect.isEnabled = true
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}