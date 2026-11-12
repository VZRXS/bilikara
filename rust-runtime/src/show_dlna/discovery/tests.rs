use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

#[test]
fn accepts_only_device_or_local_helper_locations() {
    let sender = Ipv4Addr::new(192, 168, 1, 12);
    let local = Ipv4Addr::new(192, 168, 1, 20);
    let interfaces = [local];
    for location in [
        "http://127.0.0.1/admin",
        "http://169.254.169.254/metadata",
        "http://1.1.1.1/",
        "http://example.com/",
        "http://192.168.1.13/device.xml",
        "http://user:secret@192.168.1.12/device.xml",
        "https://192.168.1.12/device.xml",
    ] {
        assert!(
            accept_location(
                location,
                Some(sender),
                Some(local),
                &interfaces,
                NetworkPolicy::Lan
            )
            .is_none(),
            "{location}"
        );
    }

    let location = "http://192.168.1.12:1234/device.xml";
    assert!(
        accept_location(
            location,
            Some(sender),
            Some(local),
            &interfaces,
            NetworkPolicy::Lan
        )
        .is_some()
    );
    assert!(
        accept_location(
            location,
            Some(local),
            Some(local),
            &interfaces,
            NetworkPolicy::Lan
        )
        .is_none()
    );
    let (_, address, helper) =
        accept_location(location, Some(local), None, &interfaces, NetworkPolicy::Lan).unwrap();
    assert_eq!((address, helper), (sender, Some(local)));
    assert!(
        accept_location(
            location,
            Some(Ipv4Addr::new(192, 168, 1, 13)),
            None,
            &interfaces,
            NetworkPolicy::Lan
        )
        .is_none()
    );
    assert!(
        accept_location(
            "http://100.64.1.20/device.xml",
            None,
            None,
            &interfaces,
            NetworkPolicy::Lan
        )
        .is_some()
    );
    assert!(
        accept_location(
            "http://100.128.1.20/device.xml",
            None,
            None,
            &interfaces,
            NetworkPolicy::Lan
        )
        .is_none()
    );
}

#[test]
fn parses_responses_and_announcements_on_their_own_sockets() {
    let response = b"http/1.1  200\r\nlocation: http://10.0.0.2:9000/device.xml\r\nusn: UUID:Test::upnp:rootdevice\r\nSERVER: device \xff\r\n\r\n";
    let sender = Ipv4Addr::new(10, 0, 0, 2);
    let local = Ipv4Addr::new(10, 0, 0, 3);
    assert!(matches!(
        parse_packet(response, sender, Some(local)),
        Some(Event::Seen { usn, reply_on: Some(address), .. }) if usn == "uuid:test" && address == local
    ));
    assert!(parse_packet(response, sender, None).is_none());
    let notify =
        b"NOTIFY * HTTP/1.1\r\nNTS: SSDP:UPDATE\r\nLOCATION: http://10.0.0.2/device.xml\r\n\r\n";
    assert!(matches!(
        parse_packet(notify, sender, None),
        Some(Event::Seen { reply_on: None, .. })
    ));
    assert!(parse_packet(notify, sender, Some(local)).is_none());
    assert!(parse_packet(search_request(MEDIA_RENDERER).as_bytes(), local, None).is_none());
}

#[test]
fn unsolicited_notify_loads_a_description_and_withdraws_before_search_ends() {
    let local = Ipv4Addr::LOCALHOST;
    let notify = UdpSocket::bind((local, 0)).unwrap();
    notify.set_nonblocking(true).unwrap();
    let target = notify.local_addr().unwrap();
    let sender = UdpSocket::bind((local, 0)).unwrap();
    let http = TcpListener::bind((local, 0)).unwrap();
    http.set_nonblocking(true).unwrap();
    let location = format!("http://{}/device.xml", http.local_addr().unwrap());
    let cancelled = AtomicBool::new(false);
    let (published, snapshots) = mpsc::channel();

    thread::scope(|scope| {
        let stop = &cancelled;
        let scan = scope.spawn(move || {
            let mut packet = [0_u8; 2048];
            collect_renderers(
                &[local],
                NetworkPolicy::LoopbackFixture,
                Duration::from_secs(8),
                move |events| receive_packets(&notify, None, &mut packet, events),
                || stop.load(Ordering::Relaxed),
                |renderers| {
                    let _ = published.send(renderers);
                },
            );
        });
        let alive = format!(
            "NOTIFY * HTTP/1.1\r\nNTS: ssdp:alive\r\nUSN: UUID:Fixture::{MEDIA_RENDERER}\r\nLOCATION: {location}\r\n\r\n"
        );
        sender.send_to(alive.as_bytes(), target).unwrap();
        sender.send_to(alive.as_bytes(), target).unwrap();

        let accept_deadline = Instant::now() + Duration::from_secs(3);
        let (mut stream, peer) = loop {
            match http.accept() {
                Ok(connection) => break connection,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        && Instant::now() < accept_deadline =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("description request did not arrive: {error}"),
            }
        };
        assert_eq!(peer.ip(), IpAddr::V4(local));
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(&stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("GET /device.xml "));
        while line != "\r\n" {
            line.clear();
            assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        }
        let body = format!(
            "<root><device><deviceType>{MEDIA_RENDERER}</deviceType><friendlyName>Notify Only</friendlyName><UDN>uuid:fixture</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/control</controlURL></service></serviceList></device></root>"
        );
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        drop(stream);

        let found = snapshots.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Notify Only");
        assert_eq!(found[0].local_address, local);
        assert!(matches!(http.accept(), Err(error) if error.kind() == io::ErrorKind::WouldBlock));
        sender.send_to(b"NOTIFY * HTTP/1.1\r\nNTS: ssdp:byebye\r\nUSN: uuid:fixture::upnp:rootdevice\r\n\r\n", target).unwrap();
        assert!(
            snapshots
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_empty()
        );

        let stopping = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        scan.join().unwrap();
        assert!(stopping.elapsed() < Duration::from_secs(1));
    });
}
