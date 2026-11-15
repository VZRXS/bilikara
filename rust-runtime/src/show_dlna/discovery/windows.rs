use super::{Event, MEDIA_RENDERER, canonical_id};
use std::sync::mpsc::SyncSender;
use windows::Win32::Devices::Enumeration::Pnp::{
    IUPnPDevice, IUPnPDeviceDocumentAccess, IUPnPDeviceFinder, IUPnPDeviceFinderCallback,
    IUPnPDeviceFinderCallback_Impl, UPnPDeviceFinder,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoUninitialize,
};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, MSG, PM_REMOVE, PeekMessageW};
use windows_core::{BSTR, Interface, Ref, Result, implement};

#[implement(IUPnPDeviceFinderCallback)]
struct Callback(SyncSender<Event>);

impl IUPnPDeviceFinderCallback_Impl for Callback_Impl {
    fn DeviceAdded(&self, _search: i32, device: Ref<'_, IUPnPDevice>) -> Result<()> {
        if let Some(device) = device.as_ref() {
            let location = document_url(device).or_else(|| {
                // Embedded renderers can expose the description URL on the root object only.
                let root = unsafe { device.RootDevice() }.ok()?;
                document_url(&root)
            });
            if let Some(location) = location {
                let usn = unsafe { device.UniqueDeviceName() }.unwrap_or_default();
                let _ = self.0.try_send(Event::Seen {
                    location: location.to_string(),
                    usn: canonical_id(&usn.to_string()),
                    sender: None,
                    reply_on: None,
                });
            }
        }
        Ok(())
    }

    fn DeviceRemoved(&self, _search: i32, udn: &BSTR) -> Result<()> {
        let usn = canonical_id(&udn.to_string());
        if !usn.is_empty() {
            let _ = self.0.try_send(Event::Left { usn, sender: None });
        }
        Ok(())
    }

    fn SearchComplete(&self, _search: i32) -> Result<()> {
        // New and removed devices keep arriving until CancelAsyncFind.
        Ok(())
    }
}

fn document_url(device: &IUPnPDevice) -> Option<BSTR> {
    let document = device.cast::<IUPnPDeviceDocumentAccess>().ok()?;
    unsafe { document.GetDocumentURL() }
        .ok()
        .filter(|url| !url.is_empty())
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) struct Discovery {
    finder: IUPnPDeviceFinder,
    search: i32,
    _callback: IUPnPDeviceFinderCallback,
    // COM interfaces must be released before the apartment is uninitialized.
    _apartment: Apartment,
}

impl Discovery {
    pub(super) fn start(events: SyncSender<Event>) -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
        let apartment = Apartment;
        let finder: IUPnPDeviceFinder =
            unsafe { CoCreateInstance(&UPnPDeviceFinder, None, CLSCTX_INPROC_SERVER) }?;
        let callback: IUPnPDeviceFinderCallback = Callback(events).into();
        let search = unsafe { finder.CreateAsyncFind(&BSTR::from(MEDIA_RENDERER), 0, &callback) }?;
        let discovery = Self {
            finder,
            search,
            _callback: callback,
            _apartment: apartment,
        };
        unsafe { discovery.finder.StartAsyncFind(search) }?;
        Ok(discovery)
    }

    pub(super) fn pump_messages(&self) {
        let mut message = MSG::default();
        for _ in 0..64 {
            if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                break;
            }
            unsafe { DispatchMessageW(&message) };
        }
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        let _ = unsafe { self.finder.CancelAsyncFind(self.search) };
    }
}
