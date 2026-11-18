//! Only the selected IPv4 route's category is exported, never network names/IDs.
use crate::dlna::diagnostics::{NetworkProfile as Profile, NetworkProfileReason as Reason};
use std::net::Ipv4Addr;

pub(super) fn query(address: Option<Ipv4Addr>) -> (Profile, Option<Reason>) {
    #[cfg(windows)]
    {
        match address
            .ok_or(Reason::NoReceiverRoute)
            .and_then(windows_category)
        {
            Ok(profile) => (profile, None),
            Err(reason) => (Profile::Unavailable, Some(reason)),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = address;
        (Profile::NotApplicable, None)
    }
}

#[cfg(windows)]
fn windows_category(address: Ipv4Addr) -> Result<Profile, Reason> {
    use windows::Win32::{Networking::NetworkListManager::*, System::Com::*};
    let adapter = crate::networking::adapter_id(address).ok_or(Reason::AdapterUnavailable)?;
    let adapter = windows::core::GUID {
        data1: adapter.data1,
        data2: adapter.data2,
        data3: adapter.data3,
        data4: adapter.data4,
    };
    // Run on a dedicated blocking worker; every successful initialization has
    // exactly one uninitialization, after all COM interface references are dropped.
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|_| Reason::ComUnavailable)?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _apartment = Apartment;
    // SAFETY: apartment is initialized; windows owns the returned COM references.
    unsafe {
        let manager: INetworkListManager = CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL)
            .map_err(|_| Reason::ComUnavailable)?;
        let connections = manager
            .GetNetworkConnections()
            .map_err(|_| Reason::QueryFailed)?;
        let mut selected = None;
        for _ in 0..4096 {
            let mut item = [None];
            let mut fetched = 0;
            connections
                .Next(&mut item, Some(&mut fetched))
                .map_err(|_| Reason::QueryFailed)?;
            if fetched == 0 {
                return selected.ok_or(Reason::NoConnectedNetwork);
            }
            let connection = item[0].take().ok_or(Reason::QueryFailed)?;
            if connection.GetAdapterId().map_err(|_| Reason::QueryFailed)? != adapter
                || !connection
                    .IsConnected()
                    .map_err(|_| Reason::QueryFailed)?
                    .as_bool()
            {
                continue;
            }
            let category = connection
                .GetNetwork()
                .and_then(|network| network.GetCategory())
                .map_err(|_| Reason::QueryFailed)?;
            selected = Some(merge_category(selected, category)?);
        }
        Err(Reason::QueryFailed)
    }
}

#[cfg(windows)]
fn merge_category(
    previous: Option<Profile>,
    category: windows::Win32::Networking::NetworkListManager::NLM_NETWORK_CATEGORY,
) -> Result<Profile, Reason> {
    use windows::Win32::Networking::NetworkListManager::*;
    let profile = match category {
        NLM_NETWORK_CATEGORY_PUBLIC => Profile::Public,
        NLM_NETWORK_CATEGORY_PRIVATE => Profile::Private,
        NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED => Profile::Domain,
        _ => return Err(Reason::QueryFailed),
    };
    if previous.is_some_and(|previous| previous != profile) {
        return Err(Reason::ConflictingCategories);
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn self_test_network_profile_categories_and_failure_reasons() {
        #[cfg(windows)]
        {
            use windows::Win32::Networking::NetworkListManager::*;
            for (input, expected) in [
                (NLM_NETWORK_CATEGORY_PUBLIC, Profile::Public),
                (NLM_NETWORK_CATEGORY_PRIVATE, Profile::Private),
                (NLM_NETWORK_CATEGORY_DOMAIN_AUTHENTICATED, Profile::Domain),
            ] {
                assert_eq!(merge_category(None, input), Ok(expected));
                assert_eq!(merge_category(Some(expected), input), Ok(expected));
            }
            assert_eq!(
                merge_category(Some(Profile::Private), NLM_NETWORK_CATEGORY_PUBLIC),
                Err(Reason::ConflictingCategories)
            );
            assert_eq!(
                merge_category(None, NLM_NETWORK_CATEGORY(99)),
                Err(Reason::QueryFailed)
            );
            assert_eq!(
                query(None),
                (Profile::Unavailable, Some(Reason::NoReceiverRoute))
            );
            assert_eq!(
                query(Some(Ipv4Addr::UNSPECIFIED)),
                (Profile::Unavailable, Some(Reason::AdapterUnavailable))
            );
        }
        #[cfg(not(windows))]
        assert_eq!(query(None), (Profile::NotApplicable, None));
    }
}
