// WebKit's default CryptoKey serializer reads a separate OS master key, even
// when Deck's API credentials already use private files. Supply the profile-owned
// key from a private file; fresh profiles never query the Keychain.
// SPI contracts: WebKit/WebKit Source/WebKit/UIProcess/API/Cocoa/
// _WKWebsiteDataStoreDelegate.h and WKNavigationDelegatePrivate.h.
#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#import <stdatomic.h>
static _Atomic(size_t) keyRequests = 0;
size_t deck_webcrypto_requests(void) { return atomic_load(&keyRequests); }

@interface DeckWebCryptoDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) NSData *key;
@property(nonatomic, strong) id original;
@end
@implementation DeckWebCryptoDelegate
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (NSData *)_webCryptoMasterKeyForWebView:(WKWebView *)view { atomic_fetch_add(&keyRequests, 1); return self.key; }
- (void)webCryptoMasterKey:(void (^)(NSData *))completionHandler { atomic_fetch_add(&keyRequests, 1); completionHandler(self.key); }
@end

// Tauri calls this on the main thread before any page can serialize a key.
// An empty NSData explicitly fails CryptoKey operations when migration failed;
// nil would make WebKit fall back to the Keychain and open another dialog.
void deck_install_webcrypto_key(void *pointer, const unsigned char *key, size_t length) {
    WKWebView *view = (__bridge WKWebView *)pointer;
    DeckWebCryptoDelegate *navigation = [DeckWebCryptoDelegate new];
    navigation.key = [NSData dataWithBytes:key length:length];
    navigation.original = view.navigationDelegate;
    objc_setAssociatedObject(view, @selector(_webCryptoMasterKeyForWebView:), navigation, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = navigation;
    // macOS 15+ also uses the store delegate for worker CryptoKey operations.
    WKWebsiteDataStore *store = view.configuration.websiteDataStore;
    SEL selector = NSSelectorFromString(@"_setDelegate:");
    if ([store respondsToSelector:selector]) {
        DeckWebCryptoDelegate *delegate = [DeckWebCryptoDelegate new];
        delegate.key = navigation.key;
        objc_setAssociatedObject(store, @selector(webCryptoMasterKey:), delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        ((void (*)(id, SEL, id))objc_msgSend)(store, selector, delegate);
    }
}
