use bilikara_runtime::{AppState, AppStateRequest};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Barrier, Mutex},
    thread,
};

#[derive(Clone)]
struct Session(Arc<Mutex<AppState>>);

impl Session {
    fn new(users: &[&str]) -> Self {
        let session = Self(Arc::new(Mutex::new(AppState::default())));
        session.initialize(json!({"session_users":users,"session_started_at":1.0,
            "session_played_file":"owned-playlist.json","updated_at":1.0}));
        session
    }

    fn wire(&self, request: Value) -> Value {
        let request: AppStateRequest = serde_json::from_value(request.clone())
            .unwrap_or_else(|error| panic!("invalid test request {request}: {error}"));
        let mut response = serde_json::to_value(self.0.lock().unwrap().execute(request)).unwrap();
        // Ownership is persisted privately, rather than exposed by the public snapshot.
        // Attach that actual persistence projection only inside this test harness.
        let owners = response["persistence"]["requester_user_ids"].clone();
        if let Some(snapshot) = response.get_mut("snapshot").and_then(Value::as_object_mut) {
            snapshot.insert("requester_user_ids".to_owned(), owners);
        }
        response
    }

    fn initialize(&self, state: Value) {
        let result = self.wire(json!({"schema_version":1,"command":"initialize","state":state}));
        assert_eq!(result["status"], "completed", "{result}");
    }

    fn attempt(&self, command: &str, mut fields: Value) -> Value {
        fields["schema_version"] = json!(1);
        fields["command"] = json!(command);
        fields["now"] = json!(1000.0);
        self.wire(fields)
    }

    fn call(&self, command: &str, fields: Value) -> Value {
        let response = self.attempt(command, fields);
        assert_eq!(response["status"], "completed", "{command}: {response}");
        response
    }

    fn snapshot(&self) -> Value {
        self.wire(json!({"schema_version":1,"command":"snapshot"}))["snapshot"].clone()
    }

    fn add(&self, id: &str, user: &str, position: &str) -> Value {
        let snapshot = self.snapshot();
        let owner = rows(&snapshot["session_user_entries"])
            .iter()
            .find(|entry| entry["name"] == user)
            .map(|entry| entry["id"].clone());
        self.call(
            "add_item",
            json!({"item":item(id,id),"requester_name":user,"requester_user_id":owner,"position":position,
            "allow_repeat":false,"reset_av_delay":false}),
        )
    }
}

fn item(id: &str, song: &str) -> Value {
    json!({"id":id,"bvid":format!("BV-{song}"),"aid":1,"cid":2,"page":1,
        "original_url":format!("https://example.test/{song}"),
        "resolved_url":format!("https://example.test/{song}?p=1"),"title":format!("title-{id}"),
        "part_title":"P1","display_title":format!("title-{id} - P1"),"cover_url":"","embed_url":"",
        "selected_pages":[1],"selected_cids":[2],"selected_durations":[120],"selected_parts":["P1"]})
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().unwrap()
}
fn ids(value: &Value) -> Vec<String> {
    rows(value)
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

fn seeded(users: &[&str], current: &str, waiting: &[&str]) -> Session {
    let session = Session::new(users);
    let mut current_item = item(current, current);
    current_item["requester_name"] = json!(&current[..1]);
    let playlist: Vec<_> = waiting
        .iter()
        .map(|id| {
            let mut row = item(id, id);
            row["requester_name"] = json!(&id[..1]);
            row
        })
        .collect();
    session.initialize(json!({"session_users":users,"current_item":current_item,
        "playlist":playlist,"session_started_at":1.0,"session_played_file":"r7.json","updated_at":1.0}));
    session
}
fn next(session: &Session) {
    let generation = session.snapshot()["playback_generation"].clone();
    session.call(
        "advance_to_next",
        json!({"expected_playback_generation":generation}),
    );
}
fn expect_ids(session: &Session, expected: &[&str]) {
    assert_eq!(ids(&session.snapshot()["playlist"]), expected);
}
const BASE: &[&str] = &["B1", "C1", "A1", "B2", "C2", "A2"];
#[test]
fn tq01_top_b2_then_next_preserves_every_other_id() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call("move_to_next", json!({"item_id":"B2"}));
    expect_ids(&s, &["B2", "B1", "C1", "A1", "C2", "A2"]);
    next(&s);
    expect_ids(&s, &["B1", "C1", "A1", "C2", "A2"]);
}
#[test]
fn tq02_top_c1_is_one_local_move() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call("move_to_next", json!({"item_id":"C1"}));
    expect_ids(&s, &["C1", "B1", "A1", "B2", "C2", "A2"]);
    next(&s);
    expect_ids(&s, &["B1", "A1", "B2", "C2", "A2"]);
}
#[test]
fn tq03_lifo_priority_preserves_ordinary_sequence() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call("move_to_next", json!({"item_id":"B2"}));
    s.call("move_to_next", json!({"item_id":"C2"}));
    expect_ids(&s, &["C2", "B2", "B1", "C1", "A1", "A2"]);
    let before = s.snapshot();
    s.call("move_to_next", json!({"item_id":"C2"}));
    assert_eq!(
        s.snapshot(),
        before,
        "already-first priority must be an exact no-op"
    );
    next(&s);
    next(&s);
    expect_ids(&s, &["B1", "C1", "A1", "A2"]);
}
#[test]
fn tq04_manual_drag_only_moves_selected_item() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call(
        "move_item_to_index",
        json!({"item_id":"C1","target_index":2}),
    );
    expect_ids(&s, &["B1", "A1", "C1", "B2", "C2", "A2"]);
}
#[test]
fn tq07_remove_current_promotes_head_before_new_admission() {
    let s = seeded(&["A", "B", "C", "D"], "A1", &["B1", "C1"]);
    s.call("remove_item", json!({"item_id":"A1"}));
    s.add("D1", "D", "tail");
    assert_eq!(s.snapshot()["current_item"]["id"], "B1");
    expect_ids(&s, &["C1", "D1"]);
}
#[test]
fn tq13_recently_skipped_requester_does_not_reset_rotation() {
    let s = seeded(&["A", "B", "C"], "B1", &["C1", "A1", "B2", "C2", "A2"]);
    let original = s.snapshot()["current_item"].clone();
    next(&s);
    assert_eq!(s.snapshot()["current_item"]["id"], "C1");
    s.call("move_to_next", json!({"item_id":"B2"}));
    expect_ids(&s, &["B2", "A1", "C2", "A2"]);
    next(&s);
    expect_ids(&s, &["A1", "C2", "A2"]);
    let rejected = s.attempt("move_to_next", json!({"item_id":"B1"}));
    assert_eq!(rejected["error"]["kind"], "queue_item_missing");
    s.call(
        "add_item",
        json!({"item":item("B1-new","B1"),"requester_name":"B","position":"tail"}),
    );
    expect_ids(&s, &["A1", "B1-new", "C2", "A2"]);
    let fresh = s.snapshot()["playlist"][1].clone();
    assert_ne!(
        fresh["item_incarnation_id"],
        original["item_incarnation_id"]
    );
    assert_eq!(fresh["bvid"], original["bvid"]);
}

#[test]
fn eight_singers_top_b2_does_not_push_b1_to_eighth() {
    let s = seeded(
        &["A", "B", "C", "D", "E", "F", "G", "H"],
        "A0",
        &["B1", "C1", "D1", "E1", "F1", "G1", "H1", "A1", "B2"],
    );
    s.call("move_to_next", json!({"item_id":"B2"}));
    next(&s);
    expect_ids(&s, &["B1", "C1", "D1", "E1", "F1", "G1", "H1", "A1"]);
}

fn persisted(session: &Session) -> Value {
    session.wire(json!({"schema_version":1,"command":"snapshot"}))["persistence"].clone()
}
fn cursor(session: &Session) -> Value {
    persisted(session)["stable_cycle_cursor"].clone()
}
fn payloads(session: &Session) -> BTreeMap<String, Value> {
    rows(&session.snapshot()["playlist"])
        .iter()
        .map(|row| {
            let mut row = row.clone();
            let id = row["id"].as_str().unwrap().to_owned();
            row.as_object_mut().unwrap().remove("queue_slot_type");
            (id, row)
        })
        .collect()
}
#[test]
fn tq04_up_down_and_manual_anchor_survive_top_next_and_insert() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    let before = payloads(&s);
    s.call("move_item", json!({"item_id":"C1","direction":"down"}));
    expect_ids(&s, &["B1", "A1", "C1", "B2", "C2", "A2"]);
    assert_eq!(payloads(&s), before);
    s.call("move_item", json!({"item_id":"C1","direction":"up"}));
    expect_ids(&s, BASE);
    s.call("move_to_next", json!({"item_id":"A2"}));
    next(&s);
    expect_ids(&s, &["B1", "C1", "A1", "B2", "C2"]);
    s.add("B3", "B", "tail");
    expect_ids(&s, &["B1", "C1", "A1", "B2", "C2", "B3"]);
    assert_eq!(s.snapshot()["playlist"][1]["queue_slot_type"], "manual");
}
#[test]
fn tq05_fixed_boundaries_and_stable_identity_do_not_follow_display_names() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call(
        "move_item_to_index",
        json!({"item_id":"C2","target_index":5}),
    );
    s.call("move_to_next", json!({"item_id":"C1"}));
    let old = ids(&s.snapshot()["playlist"]);
    s.add("C3", "C", "tail");
    let mut expected = old;
    expected.push("C3".into());
    assert_eq!(
        ids(&s.snapshot()["playlist"]),
        expected,
        "ordinary admission cannot cross the final manual boundary"
    );
    let old_cursor = cursor(&s);
    let old_owner = persisted(&s)["requester_user_ids"]["A0"].clone();
    s.call(
        "rename_session_user",
        json!({"current_name":"A","new_name":"Renamed"}),
    );
    assert_eq!(cursor(&s), old_cursor);
    assert_eq!(s.snapshot()["current_item"]["requester_name"], "A");
    s.call("remove_session_user", json!({"name":"Renamed"}));
    assert_eq!(cursor(&s)["last_user_id"], Value::Null);
    s.call("add_session_user", json!({"name":"A"}));
    s.add("A-new", "A", "tail");
    assert_ne!(persisted(&s)["requester_user_ids"]["A-new"], old_owner);
    assert_eq!(persisted(&s)["requester_user_ids"]["A0"], old_owner);
}
#[test]
fn tq06_priority_manual_and_play_now_never_consume_ordinary_turns() {
    for command in [
        "move_to_next",
        "move_item_to_index",
        "move_to_front",
        "set_current_item",
    ] {
        let s = seeded(&["A", "B", "C"], "A0", BASE);
        let baseline = cursor(&s);
        let fields = if command == "move_item_to_index" {
            json!({"item_id":"C1","target_index":0})
        } else {
            json!({"item_id":"C1"})
        };
        s.call(command, fields);
        if command == "move_to_next" {
            next(&s);
        }
        if command == "move_item_to_index" {
            next(&s);
        }
        assert_eq!(cursor(&s), baseline, "{command}");
        let old = ids(&s.snapshot()["playlist"]);
        s.add("B3", "B", "tail");
        assert_eq!(
            ids(&s.snapshot()["playlist"])
                .into_iter()
                .filter(|id| id != "B3")
                .collect::<Vec<_>>(),
            old
        );
        assert_eq!(cursor(&s), baseline);
    }
}
#[test]
fn tq06_missed_turns_are_not_compensated_and_empty_users_are_deterministic() {
    let s = seeded(&["A", "B", "C"], "C1", &["A2", "C2", "A3", "C3"]);
    s.add("B1", "B", "tail");
    expect_ids(&s, &["A2", "B1", "C2", "A3", "C3"]);
    let empty = Session::new(&[]);
    let rejected = empty.attempt(
        "add_item",
        json!({"item":item("x","x"),"position":"tail","requester_name":"A"}),
    );
    assert_eq!(rejected["error"]["kind"], "session_user_required");
    let single = Session::new(&["A"]);
    for id in ["A0", "A1", "A2"] {
        single.add(id, "A", "tail");
    }
    next(&single);
    assert_eq!(single.snapshot()["current_item"]["id"], "A1");
    expect_ids(&single, &["A2"]);
}
#[test]
fn tq07_stale_eos_and_racing_admissions_cannot_skip_the_promoted_head() {
    let s = seeded(&["A", "B", "C", "D"], "A1", &["B1", "C1"]);
    let old = s.snapshot();
    let barrier = Arc::new(Barrier::new(4));
    let mut threads = Vec::new();
    for action in 0..4 {
        let (s, barrier, old) = (s.clone(), barrier.clone(), old.clone());
        threads.push(thread::spawn(move||{barrier.wait(); match action {
            0=>s.attempt("remove_item",json!({"item_id":"A1","expected_queue_version":old["queue_version"]})),
            1=>s.attempt("advance_to_next",json!({"expected_playback_generation":old["playback_generation"],"expected_queue_version":old["queue_version"]})),
            2=>s.add("D1","D","tail"),
            _=>s.attempt("move_to_next",json!({"item_id":"C1","expected_queue_version":old["queue_version"]})),
        }}));
    }
    let mut top_won = false;
    for (index, t) in threads.into_iter().enumerate() {
        let r = t.join().unwrap();
        if index == 3 {
            top_won = r["status"] == "completed";
        }
        assert!(
            r["status"] == "completed"
                || r["error"]["kind"] == "queue_changed"
                || r["error"]["kind"] == "playback_generation_mismatch"
        );
    }
    // An admission can win first, causing both old queue-version commands to
    // reject; retry deletion against the actual current snapshot in that case.
    if s.snapshot()["current_item"]["id"] == "A1" {
        s.call("remove_item", json!({"item_id":"A1"}));
    }
    assert_eq!(
        s.snapshot()["current_item"]["id"],
        if top_won { "C1" } else { "B1" }
    );
    expect_ids(
        &s,
        if top_won {
            &["B1", "D1"]
        } else {
            &["C1", "D1"]
        },
    );
    let before = s.snapshot();
    let rejected = s.attempt(
        "advance_to_next",
        json!({"expected_playback_generation":old["playback_generation"]}),
    );
    assert_eq!(rejected["error"]["kind"], "playback_generation_mismatch");
    assert_eq!(s.snapshot(), before);
}
#[test]
fn tq08_skipped_unstarted_and_started_history_have_distinct_committed_audits() {
    for started in [false, true] {
        let s = seeded(&["A", "B", "C"], "A0", BASE);
        if started {
            s.call("mark_current_item_started", json!({"item_id":"A0"}));
        }
        let before = s.snapshot();
        next(&s);
        let after = s.snapshot();
        let events = persisted(&s)["queue_departures"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            after["history"].as_array().unwrap().len(),
            usize::from(started)
        );
        assert_eq!(
            after["session_played"].as_array().unwrap().len(),
            usize::from(started)
        );
        let departure = events.iter().find(|e| e["item_id"] == "A0").unwrap();
        assert_eq!(
            departure["reason"],
            if started {
                "advance"
            } else {
                "skipped_unstarted"
            }
        );
        assert_eq!(departure["started"], started);
        assert_eq!(
            departure["item_incarnation_id"],
            before["current_item"]["item_incarnation_id"]
        );
        assert_eq!(departure["queue_version"], after["queue_version"]);
        assert_eq!(
            departure["playback_generation"],
            after["playback_generation"]
        );
        assert!(after.get("queue_departures").is_none());
        for event in events {
            for private in ["title", "requester_name", "original_url", "token"] {
                assert!(event.get(private).is_none());
            }
        }
    }
}
#[test]
fn tq09_failed_cache_metadata_and_snapshot_refresh_never_change_id_order() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    let before = s.snapshot();
    let reservation=s.wire(json!({"schema_version":1,"command":"begin_cache_attempt","item_id":"B1","expected_item_incarnation_id":before["playlist"][0]["item_incarnation_id"]}));
    s.call("apply_cache_event",json!({"item_id":"B1","cache_attempt_token":reservation["result"]["cache_attempt_token"],"event":{"kind":"failed","message":"fixture failure"}}));
    s.call(
        "update_item",
        json!({"item_id":"C1","changes":{"title":"updated metadata"}}),
    );
    for _ in 0..3 {
        let _ = s.snapshot();
    }
    assert_eq!(ids(&s.snapshot()["playlist"]), ids(&before["playlist"]));
    assert_eq!(s.snapshot()["current_item"], before["current_item"]);
    assert_eq!(s.snapshot()["queue_version"], before["queue_version"]);
    assert_eq!(s.snapshot()["playlist"][0]["cache_status"], "failed");
    for (a, b) in rows(&before["playlist"])
        .iter()
        .zip(rows(&s.snapshot()["playlist"]))
    {
        assert_eq!(a["item_incarnation_id"], b["item_incarnation_id"]);
    }
}
#[test]
fn tq10_all_order_changing_commands_reject_old_queue_versions_without_side_effects() {
    for (command, fields) in [
        ("move_to_next", json!({"item_id":"B1"})),
        ("move_item", json!({"item_id":"B1","direction":"down"})),
        (
            "move_item_to_index",
            json!({"item_id":"B1","target_index":2}),
        ),
        ("resort_playlist_by_cycle", json!({})),
        ("remove_item", json!({"item_id":"B1"})),
        ("move_to_front", json!({"item_id":"B1"})),
        ("set_current_item", json!({"item_id":"B1"})),
        ("clear_playlist", json!({})),
        ("advance_to_next", json!({})),
    ] {
        let s = seeded(&["A", "B", "C"], "A0", BASE);
        let old = s.snapshot();
        s.call("move_to_next", json!({"item_id":"C2"}));
        let before = s.snapshot();
        let p = persisted(&s);
        let mut fields = fields;
        fields["expected_queue_version"] = old["queue_version"].clone();
        if command == "advance_to_next" {
            fields["expected_playback_generation"] = old["playback_generation"].clone();
        }
        let response = s.attempt(command, fields);
        assert_eq!(
            response["error"]["kind"], "queue_changed",
            "{command}: {response}"
        );
        assert_eq!(
            response["error"]["details"]["snapshot"]["queue_version"],
            before["queue_version"]
        );
        assert_eq!(s.snapshot(), before);
        assert_eq!(persisted(&s), p);
    }
}
#[test]
fn tq11_backup_restores_exact_waiting_order_markers_and_stable_cursor() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    s.call("move_to_next", json!({"item_id":"C1"}));
    next(&s);
    s.call(
        "move_item_to_index",
        json!({"item_id":"A2","target_index":1}),
    );
    let before = s.snapshot();
    let saved_cursor = cursor(&s);
    s.call("restore_backup", json!({}));
    let after = s.snapshot();
    assert_eq!(ids(&after["playlist"]), ids(&before["playlist"]));
    assert_eq!(cursor(&s), saved_cursor);
    assert!(after["playback_generation"].as_u64() > before["playback_generation"].as_u64());
    for (a, b) in rows(&before["playlist"])
        .iter()
        .zip(rows(&after["playlist"]))
    {
        assert_eq!(a["queue_slot_type"], b["queue_slot_type"]);
        assert_ne!(a["item_incarnation_id"], b["item_incarnation_id"]);
    }
}
#[test]
fn tq11_diagnostics_are_bounded_and_explicit_clear_has_an_exact_departure_set() {
    let s = Session::new(&["A"]);
    s.add("A0", "A", "tail");
    for n in 0..270 {
        s.add(&format!("A{n}-new"), "A", "tail");
        next(&s);
    }
    assert_eq!(
        persisted(&s)["queue_departures"].as_array().unwrap().len(),
        256
    );
    for id in ["clear1", "clear2"] {
        s.add(id, "A", "tail");
    }
    let before = s.snapshot();
    s.call("clear_playlist", json!({}));
    let p = persisted(&s);
    assert_eq!(s.snapshot()["current_item"], before["current_item"]);
    assert!(rows(&s.snapshot()["playlist"]).is_empty());
    let events = p["queue_departures"].as_array().unwrap();
    assert_eq!(
        events[events.len() - 2..]
            .iter()
            .map(|e| e["item_id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["clear1", "clear2"]
    );
    assert!(
        events[events.len() - 2..]
            .iter()
            .all(|e| e["reason"] == "clear_waiting")
    );
}

#[test]
fn tq10_public_queue_versions_survive_progress_and_reject_every_stale_operation() {
    for kind in [
        "playlist.move_next",
        "playlist.remove",
        "playlist.play_now",
        "playlist.resort",
        "playlist.move",
        "playback.next",
    ] {
        let s = seeded(&["A", "B", "C"], "A0", BASE);
        let opened=s.wire(json!({"schema_version":1,"command":"open_internet_remote_peer","peer_id":"r7","epoch":"abcdefghijklmnopqrstuv","profile":"controller"}));
        assert_eq!(opened["status"], "completed");
        let send = |seq: u64, kind: &str, body: Value| {
            s.attempt("dispatch_internet_remote_message",json!({"peer_id":"r7","lane":"control","message":json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":seq,"id":format!("00000000-0000-4000-8000-{seq:012}"),"kind":kind,"body":body}).to_string()}))
        };
        assert_eq!(
            send(1, "session.set_identity", json!({"name":"A"}))["result"]["accepted"],
            true
        );
        let old = s.snapshot();
        s.call("set_muted", json!({"is_muted":true}));
        let accepted = send(
            2,
            "playlist.move_next",
            json!({"item_id":"C2","expected_revision":old["revision"],"expected_queue_version":old["queue_version"]}),
        );
        assert_eq!(
            accepted["result"]["accepted"], true,
            "progress-only revision must not invalidate the queue token"
        );
        let before = s.snapshot();
        let mut fields = json!({"expected_queue_version":old["queue_version"]});
        if kind == "playback.next" {
            fields["playback_generation"] = before["playback_generation"].clone();
        } else {
            fields["expected_revision"] = before["revision"].clone();
            if kind != "playlist.resort" {
                fields["item_id"] = json!("B1");
            }
            if kind == "playlist.move" {
                fields["target_index"] = json!(3);
            }
        }
        let rejected = send(3, kind, fields);
        assert_eq!(rejected["result"]["accepted"], false, "{kind}: {rejected}");
        assert_eq!(rejected["result"]["code"], "queue_changed");
        assert_eq!(
            rejected["result"]["data"]["queue_version"],
            before["queue_version"]
        );
        assert_eq!(s.snapshot(), before);
        assert!(rejected["result"]["data"].get("queue_departures").is_none());
    }
}
#[test]
fn tq10_delayed_next_control_retains_its_original_queue_token() {
    let s = seeded(&["A", "B", "C"], "A0", BASE);
    let old = s.snapshot();
    let delivered=s.call("issue_player_control",json!({"control":{"action":"next-track","item_id":"A0","playback_generation":old["playback_generation"],"expected_queue_version":old["queue_version"]}}));
    assert_eq!(
        delivered["result"]["command"]["expected_queue_version"],
        old["queue_version"]
    );
    s.call("move_to_next", json!({"item_id":"C2"}));
    let before = s.snapshot();
    let stale=s.attempt("advance_to_next",json!({"expected_playback_generation":old["playback_generation"],"expected_queue_version":delivered["result"]["command"]["expected_queue_version"]}));
    assert_eq!(stale["error"]["kind"], "queue_changed");
    assert_eq!(s.snapshot(), before);
    let stale=s.attempt("issue_player_control",json!({"control":{"action":"next-track","item_id":"A0","playback_generation":old["playback_generation"],"expected_queue_version":old["queue_version"]}}));
    assert_eq!(stale["error"]["kind"], "queue_changed");
    assert_eq!(s.snapshot(), before);
}

#[test]
fn tq07_empty_current_guard_promotes_accepted_head_and_resets_per_song_controls() {
    let s = seeded(&["A", "B", "C", "D"], "A0", &["B1", "C1"]);
    s.call(
        "apply_av_delay",
        json!({"action":{"type":"set_effective","effective_delay_ms":150}}),
    );
    s.call("set_key_shift", json!({"key_shift":3}));
    let g = s.snapshot()["playback_generation"].as_u64().unwrap();
    s.call("remove_item", json!({"item_id":"A0","reset_av_delay":true}));
    assert_eq!(s.snapshot()["player_settings"]["av_offset_ms"], 0);
    assert_eq!(s.snapshot()["player_settings"]["key_shift"], 0);
    assert_eq!(s.snapshot()["playback_generation"], g + 1);
    s.call("set_current_item", json!({"item_id":null}));
    let g = s.snapshot()["playback_generation"].as_u64().unwrap();
    s.add("D1", "D", "tail");
    assert_eq!(s.snapshot()["current_item"]["id"], "C1");
    expect_ids(&s, &["D1"]);
    assert_eq!(s.snapshot()["playback_generation"], g + 1);
    assert!(rows(&s.snapshot()["history"]).is_empty());
}

#[test]
fn tq11_session_replacements_trace_exact_retired_incarnations_without_played_history() {
    for command in [
        "begin_session",
        "discard_backup",
        "reset_runtime",
        "restore_backup",
    ] {
        let s = seeded(&["A", "B", "C"], "A0", BASE);
        // Create the current backup through an actual authoritative queue commit.
        s.call("move_to_next", json!({"item_id":"B2"}));
        let before = s.snapshot();
        let mut fields = json!({});
        if command != "restore_backup" {
            fields["new_session"] =
                json!({"file_name":"next-session.json","session_started_at":2000,"items":[]});
        }
        s.call(command, fields);
        let p = persisted(&s);
        let events = p["queue_departures"].as_array().unwrap();
        let original: Vec<_> = before["current_item"]
            .as_object()
            .into_iter()
            .map(|_| before["current_item"].clone())
            .chain(rows(&before["playlist"]).iter().cloned())
            .collect();
        for item in original {
            assert!(
                events
                    .iter()
                    .any(|e| e["item_incarnation_id"] == item["item_incarnation_id"]
                        && e["to"] == "retired"),
                "{command}: {item}"
            );
        }
        assert!(rows(&s.snapshot()["history"]).is_empty());
        if command != "restore_backup" {
            assert_eq!(cursor(&s)["last_user_id"], Value::Null);
        }
    }
}
