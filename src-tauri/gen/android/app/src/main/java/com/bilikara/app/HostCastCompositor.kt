package com.bilikara.app

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import androidx.annotation.Keep
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Composited cast video (L2, external units): MediaCodec decode into a
 * SurfaceTexture, GLES draws the frame and Rust's overlay into the H.264
 * encoder's input Surface, MediaCodec encodes. Pixels never reach the CPU.
 * Rust pulls encoded units through JNI and muxes them with the L1 audio.
 * Times are source microseconds; played frames keep their source timestamps.
 * A held stream repeats the frame at the start, a blank one draws only the
 * overlay on black; both run on the capped frame grid (pause and cards of a
 * continuous cast).
 */
@Keep
object HostCastCompositor {
  private val sessions = ConcurrentHashMap<Long, Session>()
  private val ids = AtomicLong(1)

  const val SOURCE_PLAY = 0
  const val SOURCE_HOLD = 1
  const val SOURCE_BLANK = 2

  @JvmStatic @Keep
  fun open(
    path: String, source: Int, startUs: Long, endUs: Long, width: Int, height: Int,
    fpsNum: Int, fpsDen: Int, bitRate: Int,
  ): Long {
    require(width in 16..4096 && height in 16..4096 && width % 2 == 0 && height % 2 == 0)
    require(fpsNum > 0 && fpsDen > 0 && bitRate > 0 && endUs > startUs)
    require(source in SOURCE_PLAY..SOURCE_BLANK && (source == SOURCE_BLANK || path.isNotEmpty()))
    val id = ids.getAndIncrement()
    val session = Session(path, source, startUs, endUs, width, height, fpsNum, fpsDen, bitRate)
    sessions[id] = session
    session.start()
    return id
  }

  /**
   * The next unit, packed as flags (bit 0 key, bit 1 end of stream), pts and
   * dts (big-endian longs), then Annex B bytes with SPS/PPS before every key.
   * Null when nothing arrived within [timeoutMs]. Throws once the pipeline failed.
   */
  @JvmStatic @Keep
  fun next(id: Long, timeoutMs: Int): ByteArray? =
    (sessions[id] ?: throw IllegalStateException("compositor closed")).take(timeoutMs)

  /** Premultiplied RGBA at the output size; used for frames drawn after this call. */
  @JvmStatic @Keep
  fun setOverlay(id: Long, rgba: ByteArray) {
    sessions[id]?.overlay(rgba)
  }

  @JvmStatic @Keep
  fun encoderName(id: Long): String = sessions[id]?.encoderName ?: ""

  @JvmStatic @Keep
  fun close(id: Long) {
    sessions.remove(id)?.close()
  }

  private class Session(
    private val path: String,
    private val source: Int,
    private val startUs: Long,
    private val endUs: Long,
    private val width: Int,
    private val height: Int,
    private val fpsNum: Int,
    private val fpsDen: Int,
    private val bitRate: Int,
  ) {
    private val queue = ArrayBlockingQueue<ByteArray>(24)
    private val slotUs = 1_000_000L * fpsDen / fpsNum
    private val outputFps = maxOf(1, (fpsNum.toDouble() / fpsDen).roundToInt())
    @Volatile private var failure: Throwable? = null
    @Volatile private var closed = false
    @Volatile private var pendingOverlay: ByteArray? = null
    @Volatile var encoderName = ""
    private val thread = Thread({ run() }, "cast-compositor")

    fun start() = thread.start()

    fun take(timeoutMs: Int): ByteArray? {
      queue.poll()?.let { return it }
      failure?.let { throw IllegalStateException(it.message ?: it.javaClass.simpleName, it) }
      return queue.poll(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        ?: failure?.let { throw IllegalStateException(it.message ?: it.javaClass.simpleName, it) }
    }

    fun overlay(rgba: ByteArray) {
      require(rgba.size == width * height * 4) { "overlay size" }
      pendingOverlay = rgba
    }

    fun close() {
      closed = true
      thread.join(3000)
    }

    private fun put(unit: ByteArray) {
      while (!closed) if (queue.offer(unit, 100, TimeUnit.MILLISECONDS)) return
    }

    private fun run() {
      var extractor: MediaExtractor? = null
      var decoder: MediaCodec? = null
      var encoder: MediaCodec? = null
      var gl: Gl? = null
      var texture: SurfaceTexture? = null
      var decoderSurface: Surface? = null
      var frames: HandlerThread? = null
      try {
        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        encoderName = encoder.name
        configure(encoder)
        val encoderSurface = encoder.createInputSurface()
        encoder.start()
        gl = Gl(encoderSurface, width, height)
        if (source == SOURCE_BLANK) {
          still(encoder, gl, startUs, null)
          return
        }

        extractor = MediaExtractor().apply { setDataSource(path) }
        val track = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
        } ?: error("no video track")
        extractor.selectTrack(track)
        val input = extractor.getTrackFormat(track)
        val mime = input.getString(MediaFormat.KEY_MIME)!!
        extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

        val ready = Semaphore(0)
        frames = HandlerThread("cast-compositor-frames").also { it.start() }
        texture = SurfaceTexture(gl.videoTexture).apply {
          setOnFrameAvailableListener({ ready.release() }, Handler(frames.looper))
        }
        decoderSurface = Surface(texture)
        decoder = MediaCodec.createDecoderByType(mime).apply {
          configure(input, decoderSurface, null, 0)
          start()
        }
        val sourceWidth = input.getInteger(MediaFormat.KEY_WIDTH)
        val sourceHeight = input.getInteger(MediaFormat.KEY_HEIGHT)
        val matrix = FloatArray(16)
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var decoderDone = false
        var nextSlot = Long.MIN_VALUE
        var lastPts = Long.MIN_VALUE
        var config: ByteArray? = null
        if (source == SOURCE_HOLD) {
          val held = holdFirst(extractor, decoder, ready, texture, matrix, info) ?: return
          still(encoder, gl, held, Pair(matrix, Pair(sourceWidth, sourceHeight)))
          return
        }
        while (!closed) {
          if (!inputDone) {
            val index = decoder.dequeueInputBuffer(2_000)
            if (index >= 0) {
              val buffer = decoder.getInputBuffer(index)!!
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0 || extractor.sampleTime >= endUs + 1_000_000) {
                decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }
          // Drain the encoder before drawing more; a full queue back-pressures here.
          // Once decoding ended only the encoder's tail remains: wait for it.
          when (val drained = drain(encoder, info, config, if (decoderDone) 10_000 else 0)) {
            null -> return
            else -> config = drained.config.also { if (drained.ended) return }
          }
          if (decoderDone) continue
          val index = decoder.dequeueOutputBuffer(info, 2_000)
          if (index < 0) continue
          val pts = info.presentationTimeUs
          val ended = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          // Constant-rate cap: keep a frame once its slot has (nearly) come.
          val keep = info.size > 0 && pts in startUs until endUs && pts > lastPts &&
            (nextSlot == Long.MIN_VALUE || pts >= nextSlot - slotUs / 4)
          decoder.releaseOutputBuffer(index, keep)
          if (keep) {
            if (!ready.tryAcquire(2_500, TimeUnit.MILLISECONDS)) error("decoder frame timeout")
            texture.updateTexImage()
            texture.getTransformMatrix(matrix)
            pendingOverlay?.let { gl.overlay(it); pendingOverlay = null }
            gl.draw(matrix, sourceWidth, sourceHeight)
            gl.present(pts * 1_000)
            nextSlot = pts + slotUs
            lastPts = pts
          }
          if (ended || pts >= endUs) {
            decoderDone = true
            inputDone = true
            encoder.signalEndOfInputStream()
          }
        }
      } catch (error: Throwable) {
        if (!closed) failure = error
      } finally {
        runCatching { decoder?.stop() }
        runCatching { decoder?.release() }
        runCatching { encoder?.stop() }
        runCatching { encoder?.release() }
        runCatching { decoderSurface?.release() }
        runCatching { texture?.release() }
        runCatching { gl?.release() }
        runCatching { frames?.quitSafely() }
        runCatching { extractor?.release() }
      }
    }

    /**
     * Decodes up to the first frame at or after [startUs] into the texture and
     * stops the decoder there. Returns that frame's time, null once closed.
     */
    private fun holdFirst(
      extractor: MediaExtractor, decoder: MediaCodec, ready: Semaphore, texture: SurfaceTexture,
      matrix: FloatArray, info: MediaCodec.BufferInfo,
    ): Long? {
      var inputDone = false
      while (!closed) {
        if (!inputDone) {
          val index = decoder.dequeueInputBuffer(2_000)
          if (index >= 0) {
            val buffer = decoder.getInputBuffer(index)!!
            val size = extractor.readSampleData(buffer, 0)
            if (size < 0) {
              decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              decoder.queueInputBuffer(index, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        val index = decoder.dequeueOutputBuffer(info, 2_000)
        if (index < 0) continue
        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0 && info.size == 0) {
          decoder.releaseOutputBuffer(index, false)
          error("no frame at the hold position")
        }
        val pts = info.presentationTimeUs
        val keep = info.size > 0 && pts >= startUs
        decoder.releaseOutputBuffer(index, keep)
        if (!keep) continue
        if (!ready.tryAcquire(2_500, TimeUnit.MILLISECONDS)) error("decoder frame timeout")
        texture.updateTexImage()
        texture.getTransformMatrix(matrix)
        return pts
      }
      return null
    }

    /**
     * Encodes one picture on the frame grid from [originUs] until [endUs]:
     * the held texture ([video]: transform and source size) or black.
     */
    private fun still(
      encoder: MediaCodec, gl: Gl, originUs: Long, video: Pair<FloatArray, Pair<Int, Int>>?,
    ) {
      val info = MediaCodec.BufferInfo()
      var config: ByteArray? = null
      var frame = 0L
      while (!closed) {
        // Exact grid times (no accumulated rounding of the slot).
        val pts = originUs + frame * 1_000_000L * fpsDen / fpsNum
        if (pts >= endUs) {
          encoder.signalEndOfInputStream()
          while (true) {
            val drained = drain(encoder, info, config, 10_000) ?: return
            config = drained.config
            if (drained.ended) return
          }
        }
        config = (drain(encoder, info, config, 0) ?: return).config
        pendingOverlay?.let { gl.overlay(it); pendingOverlay = null }
        if (video != null) gl.draw(video.first, video.second.first, video.second.second) else gl.drawBlank()
        gl.present(pts * 1_000)
        frame++
      }
    }

    private class Drained(val config: ByteArray?, val ended: Boolean)

    /** Moves every ready encoder output into the queue; null once closed. */
    private fun drain(
      encoder: MediaCodec, info: MediaCodec.BufferInfo, known: ByteArray?, waitUs: Long,
    ): Drained? {
      var config = known
      var wait = waitUs
      while (true) {
        if (closed) return null
        val index = encoder.dequeueOutputBuffer(info, wait)
        wait = 0
        if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return Drained(config, false)
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val format = encoder.outputFormat
          config = listOfNotNull(format.getByteBuffer("csd-0"), format.getByteBuffer("csd-1"))
            .map { buffer -> ByteArray(buffer.remaining()).also { buffer.duplicate().get(it) } }
            .fold(ByteArray(0)) { all, part -> all + part }
          continue
        }
        if (index < 0) continue
        val buffer = encoder.getOutputBuffer(index)!!
        val bytes = ByteArray(info.size)
        buffer.position(info.offset)
        buffer.get(bytes)
        val flags = info.flags
        encoder.releaseOutputBuffer(index, false)
        if (flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
          config = bytes
          continue
        }
        if (bytes.isNotEmpty()) {
          val key = flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
          val data = if (key && !hasSps(bytes)) (config ?: error("missing SPS/PPS")) + bytes else bytes
          put(pack(if (key) 1 else 0, info.presentationTimeUs, data))
        }
        if (flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
          put(pack(2, 0, ByteArray(0)))
          return Drained(config, true)
        }
      }
    }

    /**
     * Encoders differ in what they accept: try High profile with CBR, then the
     * encoder's default profile, then its default rate control. SPS/PPS are
     * prepended here (from the codec config), never requested from the codec.
     */
    private fun configure(encoder: MediaCodec) {
      val capabilities = encoder.codecInfo.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
      val cbr = capabilities.encoderCapabilities.isBitrateModeSupported(
        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
      // TS timestamps here are presentation times only, so B-frames must be
      // off; High profile is requested only where that can be guaranteed.
      val high = if (Build.VERSION.SDK_INT >= 29) capabilities.profileLevels
        .filter { it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh }
        .maxByOrNull { it.level } else null
      var failure: Exception? = null
      for ((profile, rateControl) in listOf(high to cbr, null to cbr, null to false).distinct()) {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
          setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
          setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
          setInteger(MediaFormat.KEY_FRAME_RATE, outputFps)
          setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
          if (rateControl) {
            setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
          }
          if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
          profile?.let {
            setInteger(MediaFormat.KEY_PROFILE, it.profile)
            setInteger(MediaFormat.KEY_LEVEL, it.level)
          }
        }
        try {
          encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
          return
        } catch (error: IllegalArgumentException) {
          failure = error
        } catch (error: MediaCodec.CodecException) {
          failure = error
        }
        encoder.reset()
      }
      throw IllegalStateException("encoder rejected every configuration", failure)
    }
  }

  private fun hasSps(bytes: ByteArray): Boolean {
    var i = 0
    while (i + 3 < bytes.size) {
      if (bytes[i].toInt() == 0 && bytes[i + 1].toInt() == 0 && bytes[i + 2].toInt() == 1 &&
        bytes[i + 3].toInt() and 0x1f == 7) return true
      i++
    }
    return false
  }

  private fun pack(flags: Int, pts: Long, data: ByteArray): ByteArray =
    ByteBuffer.allocate(17 + data.size).order(ByteOrder.BIG_ENDIAN).apply {
      put(flags.toByte())
      putLong(pts)
      putLong(pts)
      put(data)
    }.array()

  /** EGL on the encoder's input Surface: video quad, then the overlay. */
  private class Gl(surface: Surface, private val width: Int, private val height: Int) {
    private val display: EGLDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    private val context: EGLContext
    private val target: EGLSurface
    val videoTexture: Int
    private val overlayTexture: Int
    private var hasOverlay = false
    private val videoProgram: Int
    private val overlayProgram: Int
    private val quad: FloatBuffer = ByteBuffer.allocateDirect(4 * 4 * 4).order(ByteOrder.nativeOrder())
      .asFloatBuffer().apply {
        // x, y, u, v; v is flipped for the top-row-first overlay in its shader.
        put(floatArrayOf(-1f, -1f, 0f, 0f, 1f, -1f, 1f, 0f, -1f, 1f, 0f, 1f, 1f, 1f, 1f, 1f))
        position(0)
      }

    init {
      val version = IntArray(2)
      check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize" }
      val attributes = intArrayOf(
        EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
        EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE,
      )
      val configs = arrayOfNulls<EGLConfig>(1)
      val count = IntArray(1)
      check(EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) && count[0] > 0) {
        "eglChooseConfig"
      }
      context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
        intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
      check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext" }
      target = EGL14.eglCreateWindowSurface(display, configs[0], surface, intArrayOf(EGL14.EGL_NONE), 0)
      check(target != EGL14.EGL_NO_SURFACE) { "eglCreateWindowSurface" }
      check(EGL14.eglMakeCurrent(display, target, target, context)) { "eglMakeCurrent" }
      val textures = IntArray(2)
      GLES20.glGenTextures(2, textures, 0)
      videoTexture = textures[0]
      overlayTexture = textures[1]
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, videoTexture)
      parameters(GLES11Ext.GL_TEXTURE_EXTERNAL_OES)
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, overlayTexture)
      parameters(GLES20.GL_TEXTURE_2D)
      videoProgram = program(
        """
        attribute vec4 position; attribute vec4 coordinate; uniform mat4 transform; varying vec2 uv;
        void main() { gl_Position = position; uv = (transform * coordinate).xy; }
        """,
        """
        #extension GL_OES_EGL_image_external : require
        precision mediump float; varying vec2 uv; uniform samplerExternalOES frame;
        void main() { gl_FragColor = texture2D(frame, uv); }
        """,
      )
      overlayProgram = program(
        """
        attribute vec4 position; attribute vec4 coordinate; varying vec2 uv;
        void main() { gl_Position = position; uv = vec2(coordinate.x, 1.0 - coordinate.y); }
        """,
        """
        precision mediump float; varying vec2 uv; uniform sampler2D overlay;
        void main() { gl_FragColor = texture2D(overlay, uv); }
        """,
      )
    }

    fun overlay(rgba: ByteArray) {
      var visible = false
      var i = 3
      while (i < rgba.size) { if (rgba[i].toInt() != 0) { visible = true; break }; i += 4 }
      hasOverlay = visible
      if (!visible) return
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, overlayTexture)
      GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, width, height, 0,
        GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, ByteBuffer.wrap(rgba))
    }

    fun draw(transform: FloatArray, sourceWidth: Int, sourceHeight: Int) {
      GLES20.glDisable(GLES20.GL_BLEND)
      GLES20.glViewport(0, 0, width, height)
      GLES20.glClearColor(0f, 0f, 0f, 1f)
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      // Contain-fit with black bars, like the Audience stage.
      val scale = min(width.toFloat() / sourceWidth, height.toFloat() / sourceHeight)
      val w = (sourceWidth * scale).roundToInt()
      val h = (sourceHeight * scale).roundToInt()
      GLES20.glViewport((width - w) / 2, (height - h) / 2, w, h)
      GLES20.glUseProgram(videoProgram)
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, videoTexture)
      GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(videoProgram, "transform"), 1, false, transform, 0)
      quad(videoProgram)
      drawOverlay()
    }

    private fun drawOverlay() {
      if (!hasOverlay) return
      GLES20.glViewport(0, 0, width, height)
      GLES20.glEnable(GLES20.GL_BLEND)
      GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
      GLES20.glUseProgram(overlayProgram)
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, overlayTexture)
      quad(overlayProgram)
    }

    fun drawBlank() {
      GLES20.glDisable(GLES20.GL_BLEND)
      GLES20.glViewport(0, 0, width, height)
      GLES20.glClearColor(0f, 0f, 0f, 1f)
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      drawOverlay()
    }

    fun present(nanos: Long) {
      EGLExt.eglPresentationTimeANDROID(display, target, nanos)
      check(EGL14.eglSwapBuffers(display, target)) { "eglSwapBuffers" }
    }

    fun release() {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
      EGL14.eglDestroySurface(display, target)
      EGL14.eglDestroyContext(display, context)
      EGL14.eglReleaseThread()
      EGL14.eglTerminate(display)
    }

    private fun quad(program: Int) {
      val position = GLES20.glGetAttribLocation(program, "position")
      val coordinate = GLES20.glGetAttribLocation(program, "coordinate")
      quad.position(0)
      GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 16, quad)
      GLES20.glEnableVertexAttribArray(position)
      quad.position(2)
      GLES20.glVertexAttribPointer(coordinate, 2, GLES20.GL_FLOAT, false, 16, quad)
      GLES20.glEnableVertexAttribArray(coordinate)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun parameters(target: Int) {
      GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    private fun program(vertex: String, fragment: String): Int {
      fun shader(type: Int, source: String): Int = GLES20.glCreateShader(type).also {
        GLES20.glShaderSource(it, source)
        GLES20.glCompileShader(it)
        val ok = IntArray(1)
        GLES20.glGetShaderiv(it, GLES20.GL_COMPILE_STATUS, ok, 0)
        check(ok[0] != 0) { "shader: " + GLES20.glGetShaderInfoLog(it) }
      }
      return GLES20.glCreateProgram().also {
        GLES20.glAttachShader(it, shader(GLES20.GL_VERTEX_SHADER, vertex))
        GLES20.glAttachShader(it, shader(GLES20.GL_FRAGMENT_SHADER, fragment))
        GLES20.glLinkProgram(it)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(it, GLES20.GL_LINK_STATUS, ok, 0)
        check(ok[0] != 0) { "program: " + GLES20.glGetProgramInfoLog(it) }
      }
    }

    private companion object {
      const val EGL_RECORDABLE_ANDROID = 0x3142
    }
  }
}
