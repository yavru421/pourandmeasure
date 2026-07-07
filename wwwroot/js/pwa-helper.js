(function () {
    'use strict';

    // 1. Show PWA installation prompt only on iOS Safari if not in standalone mode
    const isIos = () => {
        const userAgent = window.navigator.userAgent.toLowerCase();
        return /iphone|ipad|ipod/.test(userAgent);
    };
    const isInStandaloneMode = () => ('standalone' in window.navigator) && (window.navigator.standalone);

    document.addEventListener('DOMContentLoaded', () => {
        const prompt = document.getElementById('ios-pwa-prompt');
        if (prompt && isIos() && !isInStandaloneMode()) {
            prompt.style.display = 'block';
        }

        const closeBtn = document.getElementById('ios-pwa-prompt-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                const p = document.getElementById('ios-pwa-prompt');
                if (p) p.style.display = 'none';
            });
        }
    });

    // 2. Request persistent storage defensively for iOS 7-day eviction
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            if (granted) {
                console.log("Storage will not be cleared except by explicit user action");
            } else {
                console.log("Storage may be cleared by the UA under storage pressure.");
            }
        });
    }

    // 3. Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(registration => {
            registration.onupdatefound = () => {
                const installingWorker = registration.installing;
                if (installingWorker == null) {
                    return;
                }
                installingWorker.onstatechange = () => {
                    if (installingWorker.state === 'installed') {
                        if (navigator.serviceWorker.controller) {
                            // A new service worker has been installed and is ready to take over.
                            console.log('New or updated content is available. Please refresh the page to update.');
                        }
                    }
                };
            };
        }).catch(err => {
            console.error('Service worker registration failed:', err);
        });
    }

    // 4. High-speed blob transmission stream bypass framework
    window.shotStackSaver = {
        saveAndDownloadFile: function (filename, byteBase64) {
            try {
                // Convert base64 to byte array
                const byteCharacters = atob(byteBase64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                
                // Create File object for sharing
                const file = new File([byteArray], filename, { type: 'application/pdf' });
                
                // Use Web Share API if supported (critical for mobile PWA standalone mode)
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    navigator.share({
                        files: [file],
                        title: 'ShotStack Studio PDF',
                        text: 'Your compiled PDF document is ready.'
                    }).catch(err => {
                        console.log('User canceled or share failed, falling back to download:', err);
                        window.shotStackSaver.triggerFallbackDownload(filename, byteArray);
                    });
                } else {
                    window.shotStackSaver.triggerFallbackDownload(filename, byteArray);
                }
            } catch (error) {
                console.error('File saving failed:', error);
            }
        },
        triggerFallbackDownload: function (filename, byteArray) {
            const blob = new Blob([byteArray], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            
            const link = document.createElement('a');
            link.download = filename;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        }
    };
})();
