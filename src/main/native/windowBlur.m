#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <node_api.h>

static napi_value SetBlur(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2], result;
    void *data;
    size_t length;
    int32_t radius;
    int32_t status = -1;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) == napi_ok &&
        count == 2 && napi_get_buffer_info(env, args[0], &data, &length) == napi_ok &&
        length == sizeof(void *) && napi_get_value_int32(env, args[1], &radius) == napi_ok) {
        void *pointer;
        memcpy(&pointer, data, sizeof(pointer));
        NSView *view = (__bridge NSView *)pointer;
        void *library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
        if (library && view.window.windowNumber > 0) {
            int (*connection)(void) = dlsym(library, "CGSMainConnectionID");
            int (*blur)(int, int, int) = dlsym(library, "CGSSetWindowBackgroundBlurRadius");
            if (connection && blur) status = blur(connection(), (int)view.window.windowNumber, radius);
        }
        if (library) dlclose(library);
    }
    napi_create_int32(env, status, &result);
    return result;
}
NAPI_MODULE_INIT() {
    napi_value fn;
    napi_create_function(env, "setBlur", NAPI_AUTO_LENGTH, SetBlur, NULL, &fn);
    napi_set_named_property(env, exports, "setBlur", fn);
    return exports;
}
