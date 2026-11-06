// hush-audio-capture — WORK IN PROGRESS, NOT TESTED ON A REAL PC YET.
//
// Captures everything this PC is playing EXCEPT one process tree (Hush itself), so that screen
// audio doesn't send the call back to the other person. Electron's built-in capture can't leave
// anything out, which is why this small helper exists. Uses Windows process loopback.
//
//   hush-audio-capture --exclude-pid <pid>          raw PCM on stdout (s16le, stereo, 48 kHz)
//   hush-audio-capture --exclude-pid <pid> --probe  only checks that capture can start
//
// stderr: "ready" once capturing, or "error: ..." before exiting with a non-zero code.
// Exits when stdin closes, so it can't outlive Hush.

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace {

int fail(const char* what, HRESULT hr) {
  std::fprintf(stderr, "error: %s (0x%08lx)\n", what, static_cast<unsigned long>(hr));
  std::fflush(stderr);
  return 1;
}

// ActivateAudioInterfaceAsync reports back on another thread; this waits for it.
class Activation : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
 public:
  explicit Activation(HANDLE done) : done_(done) {}

  STDMETHODIMP QueryInterface(REFIID iid, void** out) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (iid == __uuidof(IAgileObject)) {
      *out = static_cast<IAgileObject*>(this);
    } else {
      *out = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
  STDMETHODIMP_(ULONG) Release() override {
    const ULONG left = InterlockedDecrement(&refs_);
    if (left == 0) delete this;
    return left;
  }

  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
    IUnknown* unknown = nullptr;
    HRESULT activated = E_FAIL;
    result = op->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result)) result = unknown->QueryInterface(IID_PPV_ARGS(&client));
    if (unknown) unknown->Release();
    SetEvent(done_);
    return S_OK;
  }

  HRESULT result = E_FAIL;
  IAudioClient* client = nullptr;

 private:
  LONG refs_ = 1;
  HANDLE done_;
};

// Signals `stop` when Hush closes our stdin (or dies).
DWORD WINAPI watchStdin(void* stop) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  char buffer[64];
  DWORD got = 0;
  while (ReadFile(in, buffer, sizeof buffer, &got, nullptr) && got > 0) {
  }
  SetEvent(static_cast<HANDLE>(stop));
  return 0;
}

bool writeAll(HANDLE out, const BYTE* data, DWORD size) {
  while (size > 0) {
    DWORD written = 0;
    if (!WriteFile(out, data, size, &written, nullptr)) return false;
    data += written;
    size -= written;
  }
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  DWORD excludePid = 0;
  bool probe = false;
  for (int i = 1; i < argc; i++) {
    if (std::strcmp(argv[i], "--exclude-pid") == 0 && i + 1 < argc) excludePid = static_cast<DWORD>(std::strtoul(argv[++i], nullptr, 10));
    else if (std::strcmp(argv[i], "--probe") == 0) probe = true;
  }
  if (excludePid == 0) return fail("--exclude-pid is required", E_INVALIDARG);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail("CoInitializeEx", hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = excludePid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof params;
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  HANDLE activated = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  Activation* activation = new Activation(activated);
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams, activation, &op);
  if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync (needs a recent Windows 10 or 11)", hr);
  if (WaitForSingleObject(activated, 5000) != WAIT_OBJECT_0) return fail("activation timed out", E_FAIL);
  if (FAILED(activation->result)) return fail("activating process loopback", activation->result);
  IAudioClient* client = activation->client;

  // Process loopback has no mix format to ask for, so we name the one we want.
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 16;
  format.nBlockAlign = 4;
  format.nAvgBytesPerSec = 48000 * 4;
  const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, &format, nullptr);
  if (FAILED(hr)) return fail("IAudioClient::Initialize", hr);

  HANDLE samples = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(samples);
  if (FAILED(hr)) return fail("SetEventHandle", hr);
  IAudioCaptureClient* capture = nullptr;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) return fail("GetService", hr);

  if (probe) {
    std::fprintf(stderr, "ready\n");
    return 0;
  }

  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE watcher = CreateThread(nullptr, 0, watchStdin, stop, 0, nullptr);
  if (!watcher) return fail("CreateThread", HRESULT_FROM_WIN32(GetLastError()));

  hr = client->Start();
  if (FAILED(hr)) return fail("IAudioClient::Start", hr);
  std::fprintf(stderr, "ready\n");
  std::fflush(stderr);

  HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE waits[2] = {stop, samples};
  std::vector<BYTE> silence;
  for (;;) {
    const DWORD woke = WaitForMultipleObjects(2, waits, FALSE, 1000);
    if (woke == WAIT_OBJECT_0) break;
    if (woke != WAIT_OBJECT_0 + 1) continue;  // nothing is playing
    for (;;) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD bufferFlags = 0;
      hr = capture->GetBuffer(&data, &frames, &bufferFlags, nullptr, nullptr);
      if (hr == AUDCLNT_S_BUFFER_EMPTY) break;
      if (FAILED(hr)) return fail("GetBuffer", hr);
      const DWORD bytes = frames * format.nBlockAlign;
      if (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(bytes, 0);
        data = silence.data();
      }
      const bool wrote = writeAll(out, data, bytes);
      capture->ReleaseBuffer(frames);
      if (!wrote) return 0;  // Hush went away
    }
  }
  client->Stop();
  return 0;
}
