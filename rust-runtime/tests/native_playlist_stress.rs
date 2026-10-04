use bilikara_runtime::{AppState, AppStateRequest};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
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
        serde_json::to_value(self.0.lock().unwrap().execute(request)).unwrap()
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
        self.call(
            "add_item",
            json!({"item":item(id,id),"requester_name":user,"position":position,
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
fn active(snapshot: &Value) -> Vec<Value> {
    let mut result = rows(&snapshot["playlist"]).to_vec();
    if !snapshot["current_item"].is_null() {
        result.push(snapshot["current_item"].clone());
    }
    result
}
fn ended(snapshot: &Value) -> BTreeSet<String> {
    let entries: Vec<_> = rows(&snapshot["session_played"])
        .iter()
        .filter(|row| !row["ended_at"].is_null())
        .map(|row| row["item_id"].as_str().unwrap().to_owned())
        .collect();
    let unique: BTreeSet<_> = entries.iter().cloned().collect();
    assert_eq!(entries.len(), unique.len(), "ended programs must be unique");
    unique
}
fn canonical(mut value: Value) -> Value {
    value.as_object_mut().unwrap().remove("queue_slot_type");
    value
}

// Independent bucket/round oracle, not the production cycle keys or planner.
fn cycle_schedule(snapshot: &Value, candidate: Option<&Value>) -> Vec<String> {
    let mut seats: Vec<_> = rows(&snapshot["session_users"])
        .iter()
        .map(|u| u.as_str().unwrap())
        .collect();
    if let Some(index) = seats
        .iter()
        .position(|&u| snapshot["current_item"]["requester_name"] == u)
    {
        let count = seats.len();
        seats.rotate_left((index + 1) % count);
    }
    let mut buckets: Vec<Vec<String>> = seats
        .iter()
        .map(|&user| {
            rows(&snapshot["playlist"])
                .iter()
                .filter(|row| row["queue_slot_type"] == "cycle" && row["requester_name"] == user)
                .map(|row| row["id"].as_str().unwrap().to_owned())
                .collect()
        })
        .collect();
    if let Some(candidate) = candidate {
        let index = seats
            .iter()
            .position(|&u| candidate["requester_name"] == u)
            .unwrap();
        buckets[index].push(candidate["id"].as_str().unwrap().to_owned());
    }
    (0..buckets.iter().map(Vec::len).max().unwrap_or(0))
        .flat_map(|round| {
            buckets
                .iter()
                .filter_map(move |bucket| bucket.get(round).cloned())
        })
        .collect()
}
fn assert_cycle(snapshot: &Value) {
    let actual: Vec<_> = rows(&snapshot["playlist"])
        .iter()
        .filter(|row| {
            row["queue_slot_type"] == "cycle"
                && rows(&snapshot["session_users"]).contains(&row["requester_name"])
        })
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(actual, cycle_schedule(snapshot, None));
}
fn assert_conserved(snapshot: &Value, admitted: &BTreeMap<String, Value>) {
    let entries = active(snapshot);
    let actual: BTreeSet<_> = entries
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    let retired = ended(snapshot);
    assert_eq!(actual.len(), entries.len());
    assert!(actual.is_disjoint(&retired));
    assert_eq!(
        actual.union(&retired).cloned().collect::<BTreeSet<_>>(),
        admitted.keys().cloned().collect()
    );
    let users = rows(&snapshot["session_users"]);
    assert!(users.len() <= 32);
    assert_eq!(
        users.len(),
        users
            .iter()
            .map(Value::to_string)
            .collect::<BTreeSet<_>>()
            .len()
    );
    for entry in entries {
        assert_eq!(
            canonical(entry.clone()),
            canonical(admitted[entry["id"].as_str().unwrap()].clone())
        );
    }
}

// Test-only deterministic stimulus; it does not model any application policy.
struct Random(u64);
impl Random {
    fn pick(&mut self, limit: usize) -> usize {
        assert!(limit > 0);
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((value ^ (value >> 31)) % limit as u64) as usize
    }
}

#[test]
fn single_fixed_markers_latest_top_and_per_singer_order_have_literal_results() {
    for manual in [false, true] {
        let session = Session::new(&["A", "B", "C", "D"]);
        session.add("playing", "A", "tail");
        if manual {
            session.add("b1", "B", "tail");
            session.add("a1", "A", "tail");
            session.call(
                "move_item_to_index",
                json!({"item_id":"a1","target_index":0}),
            );
            session.call("remove_item", json!({"item_id":"b1"}));
            assert_eq!(
                session.snapshot()["playlist"][0]["queue_slot_type"],
                "manual"
            );
        } else {
            session.add("a1", "A", "next");
        }
        assert_eq!(
            session.call("resort_playlist_by_cycle", json!({}))["committed"],
            true
        );
        assert_eq!(
            session.snapshot()["playlist"][0]["queue_slot_type"],
            "cycle"
        );
        session.add("b2", "B", "tail");
        assert_eq!(ids(&session.snapshot()["playlist"]), ["b2", "a1"]);
    }
    let session = Session::new(&["A", "B", "C", "D"]);
    session.add("playing", "A", "tail");
    for (id, user) in [("b1", "B"), ("c1", "C"), ("a1", "A"), ("b2", "B")] {
        session.add(id, user, "tail");
    }
    let before = session.snapshot();
    for id in ["b2", "c1", "c1"] {
        session.call("move_to_next", json!({"item_id":id}));
    }
    let after = session.snapshot();
    assert_eq!(ids(&after["playlist"]), ["c1", "b2", "b1", "a1"]);
    for key in ["current_item", "playback_generation", "session_played"] {
        assert_eq!(after[key], before[key]);
    }
    let session = Session::new(&["A", "B"]);
    session.add("playing", "A", "tail");
    for (id, user) in [("a1", "A"), ("a2", "A"), ("b1", "B"), ("b2", "B")] {
        session.add(id, user, "tail");
    }
    session.call("move_to_next", json!({"item_id":"a2"}));
    session.call("resort_playlist_by_cycle", json!({}));
    assert_eq!(
        ids(&session.snapshot()["playlist"]),
        ["b1", "a2", "b2", "a1"]
    );
    assert!(
        rows(&session.snapshot()["playlist"])
            .iter()
            .all(|row| row["queue_slot_type"] == "cycle")
    );
}

#[test]
fn eight_concurrent_reorder_callers_preserve_payloads_and_current_program() {
    let session = Session::new(&["A", "B", "C", "D"]);
    session.add("playing", "A", "tail");
    for index in 0..32 {
        session.add(
            &format!("q{index}"),
            ["A", "B", "C", "D"][index % 4],
            "tail",
        );
    }
    let before = session.snapshot();
    let expected: BTreeMap<_, _> = rows(&before["playlist"])
        .iter()
        .map(|e| (e["id"].to_string(), canonical(e.clone())))
        .collect();
    let barrier = Arc::new(Barrier::new(8));
    let threads:Vec<_>=(0..8).map(|worker|{let (session,barrier,before,expected)=(session.clone(),barrier.clone(),before.clone(),expected.clone());thread::spawn(move||{
        let mut random=Random(11400+worker);barrier.wait();
        for _ in 0..80 {
            let id=format!("q{}",random.pick(32));
            let (command,fields)=match random.pick(4) {
                0=>("move_to_next",json!({"item_id":id})),
                1=>("move_item_to_index",json!({"item_id":id,"target_index":random.pick(36) as i64-2})),
                2=>("move_item",json!({"item_id":id,"direction":if random.pick(2)==0 {"up"} else {"down"}})),
                _=>("resort_playlist_by_cycle",json!({})),
            };
            let response=session.call(command,fields);let snapshot=&response["snapshot"];
            let actual:BTreeMap<_,_>=rows(&snapshot["playlist"]).iter().map(|e|(e["id"].to_string(),canonical(e.clone()))).collect();
            assert_eq!(rows(&snapshot["playlist"]).len(),32);assert_eq!(actual,expected);
            for key in ["current_item","playback_generation","session_played"] { assert_eq!(snapshot[key],before[key]); }
        }
    })}).collect();
    for thread in threads {
        thread.join().unwrap();
    }
}

fn lifecycle(seeds: usize, steps: usize) {
    let mut counts = BTreeMap::<String, usize>::new();
    let mut stale = 0;
    for seed in 0..seeds {
        let mut random = Random(914000 + seed as u64);
        let users: Vec<_> = (0..random.pick(32) + 1).map(|i| format!("U{i}")).collect();
        let session = Session::new(&users.iter().map(String::as_str).collect::<Vec<_>>());
        let mut admitted = BTreeMap::<String, Value>::new();
        let mut serial = 0;
        for step in 0..steps {
            let before = session.snapshot();
            let queue = rows(&before["playlist"]);
            let users = rows(&before["session_users"]);
            let choice = random.pick(15);
            let mut error = None;
            let mut requested = None;
            let (command, fields) = match choice {
                0..=2 if queue.len() < 48 => {
                    let id = format!("s{seed:03}{serial:06}");
                    serial += 1;
                    requested = Some(id.clone());
                    if users.is_empty() {
                        error = Some("session_user_required");
                    }
                    (
                        "add_item",
                        json!({"item":item(&id,&id),"requester_name":if users.is_empty(){json!("missing")}else{users[random.pick(users.len())].clone()},"position":if choice==2 {"next"}else{"tail"},"reset_av_delay":false,"allow_repeat":false}),
                    )
                }
                3 | 4 | 13 | 14 => {
                    let id = if queue.is_empty() || choice == 14 {
                        json!("missing")
                    } else {
                        queue[random.pick(queue.len())]["id"].clone()
                    };
                    if id == "missing" {
                        error = Some("queue_item_missing");
                    }
                    if choice == 3 {
                        ("move_to_next", json!({"item_id":id}))
                    } else if choice == 13 {
                        (
                            "move_to_front",
                            json!({"item_id":id,"reset_av_delay":false}),
                        )
                    } else {
                        (
                            "move_item_to_index",
                            json!({"item_id":id,"target_index":random.pick(queue.len()+7) as i64-3}),
                        )
                    }
                }
                5 => (
                    "move_session_user_to_index",
                    json!({"name":if users.is_empty(){json!("missing")}else{users[random.pick(users.len())].clone()},"target_index":random.pick(users.len()+7) as i64-3}),
                ),
                6 => {
                    let name = json!(format!("U{}", random.pick(64)));
                    if users.contains(&name) {
                        error = Some("duplicate_session_user");
                    } else if users.len() == 32 {
                        error = Some("too_many_session_users");
                    }
                    ("add_session_user", json!({"name":name}))
                }
                7 => (
                    "remove_session_user",
                    json!({"name":if users.is_empty(){json!("missing")}else{users[random.pick(users.len())].clone()}}),
                ),
                10 => {
                    let name = if users.is_empty() {
                        json!("missing")
                    } else {
                        users[random.pick(users.len())].clone()
                    };
                    let new = json!(format!("U{}", random.pick(64)));
                    if users.is_empty() {
                        error = Some("session_user_not_found");
                    } else if new != name && users.contains(&new) {
                        error = Some("duplicate_session_user");
                    }
                    (
                        "rename_session_user",
                        json!({"current_name":name,"new_name":new}),
                    )
                }
                9 | 11 => {
                    let generation = before["playback_generation"].as_u64().unwrap();
                    let old = choice == 11 && generation > 1;
                    if old {
                        error = Some("playback_generation_mismatch");
                        stale += 1;
                    }
                    (
                        "advance_to_next",
                        json!({"expected_playback_generation":if old {generation-1}else{generation},"reset_av_delay":false}),
                    )
                }
                12 if !active(&before).is_empty() && !users.is_empty() => {
                    let available = active(&before);
                    let mut duplicate = available[random.pick(available.len())].clone();
                    duplicate["id"] = json!(format!("s{seed:03}{serial:06}"));
                    serial += 1;
                    error = Some("duplicate_session_request");
                    (
                        "add_item",
                        json!({"item":duplicate,"requester_name":users[random.pick(users.len())],"position":"tail","allow_repeat":false,"reset_av_delay":false}),
                    )
                }
                _ => ("resort_playlist_by_cycle", json!({})),
            };
            *counts.entry(command.into()).or_default() += 1;
            let response = session.attempt(command, fields.clone());
            if let Some(kind) = error {
                assert_eq!(
                    response["error"]["kind"], kind,
                    "seed={seed} step={step} {command}: {response}"
                );
                assert_eq!(session.snapshot(), before);
                continue;
            }
            assert_eq!(
                response["status"], "completed",
                "seed={seed} step={step} {command}: {response}"
            );
            let after = &response["snapshot"];
            // Expected removals come from submitted actions, never from the
            // returned ledger: losing a song cannot be hidden by ending it.
            let mut expected_queue: BTreeSet<_> = ids(&before["playlist"]).into_iter().collect();
            let mut expected_ended = ended(&before);
            let mut replaces = false;
            if let Some(id) = &requested {
                if !before["current_item"].is_null() {
                    expected_queue.insert(id.clone());
                }
            } else if command == "advance_to_next" {
                if let Some(row) = queue.first() {
                    expected_queue.remove(row["id"].as_str().unwrap());
                }
                replaces = true;
            } else if command == "move_to_front" {
                assert!(expected_queue.remove(fields["item_id"].as_str().unwrap()));
                replaces = true;
            }
            if replaces && !before["current_item"].is_null() {
                expected_ended.insert(before["current_item"]["id"].as_str().unwrap().to_owned());
            }
            assert_eq!(
                ids(&after["playlist"]).into_iter().collect::<BTreeSet<_>>(),
                expected_queue,
                "seed={seed} step={step} {command}"
            );
            assert_eq!(
                ended(after),
                expected_ended,
                "seed={seed} step={step} {command}"
            );
            if let Some(id) = requested {
                let entry = active(after).into_iter().find(|e| e["id"] == id).unwrap();
                admitted.insert(id.clone(), entry.clone());
                if !before["current_item"].is_null() {
                    let old = ids(&before["playlist"]);
                    let new = ids(&after["playlist"]);
                    if fields["position"] == "next" {
                        assert_eq!(new, [vec![id.clone()], old].concat());
                    } else {
                        assert_eq!(
                            new.iter()
                                .filter(|x| **x != id)
                                .cloned()
                                .collect::<Vec<_>>(),
                            old
                        );
                        let scheduled = cycle_schedule(&before, Some(&entry));
                        let position = scheduled.iter().position(|x| *x == id).unwrap();
                        let mut predecessors: BTreeSet<_> =
                            scheduled[..position].iter().cloned().collect();
                        predecessors.extend(
                            queue
                                .iter()
                                .filter(|e| {
                                    e["queue_slot_type"] != "cycle"
                                        || !users.contains(&e["requester_name"])
                                })
                                .map(|e| e["id"].as_str().unwrap().to_owned()),
                        );
                        let expected = old
                            .iter()
                            .enumerate()
                            .filter(|(_, id)| predecessors.contains(*id))
                            .map(|(i, _)| i + 1)
                            .max()
                            .unwrap_or(0);
                        assert_eq!(new.iter().position(|x| *x == id), Some(expected));
                    }
                }
            }
            if command == "rename_session_user" {
                for entry in admitted.values_mut() {
                    if entry["requester_name"] == fields["current_name"] {
                        entry["requester_name"] = fields["new_name"].clone();
                    }
                }
            }
            assert_conserved(after, &admitted);
            if ![
                "advance_to_next",
                "move_to_front",
                "add_item",
                "rename_session_user",
            ]
            .contains(&command)
            {
                for key in ["current_item", "playback_generation"] {
                    assert_eq!(after[key], before[key]);
                }
            }
            if command == "resort_playlist_by_cycle" {
                assert!(
                    rows(&after["playlist"])
                        .iter()
                        .all(|e| e["queue_slot_type"] == "cycle")
                );
                for user in users {
                    let by_user = |list: &Value| {
                        rows(list)
                            .iter()
                            .filter(|e| e["requester_name"] == *user)
                            .map(|e| e["id"].clone())
                            .collect::<Vec<_>>()
                    };
                    assert_eq!(by_user(&after["playlist"]), by_user(&before["playlist"]));
                }
            }
            if command == "move_to_next" {
                assert_eq!(after["playlist"][0]["id"], fields["item_id"]);
                assert_eq!(after["playlist"][0]["queue_slot_type"], "priority");
            }
            if command == "move_item_to_index" {
                let target = fields["target_index"]
                    .as_i64()
                    .unwrap()
                    .clamp(0, queue.len() as i64 - 1) as usize;
                assert_eq!(after["playlist"][target]["id"], fields["item_id"]);
            }
            if command == "move_session_user_to_index" && !users.is_empty() {
                let mut expected = users.to_vec();
                let from = expected.iter().position(|u| *u == fields["name"]).unwrap();
                let user = expected.remove(from);
                expected.insert(
                    fields["target_index"]
                        .as_i64()
                        .unwrap()
                        .clamp(0, users.len() as i64 - 1) as usize,
                    user,
                );
                assert_eq!(rows(&after["session_users"]), expected);
            }
            if response["committed"] == true && command != "add_item" {
                assert_cycle(after);
            }
            if [
                "add_session_user",
                "remove_session_user",
                "rename_session_user",
                "move_session_user_to_index",
                "resort_playlist_by_cycle",
            ]
            .contains(&command)
            {
                for (index, entry) in queue.iter().enumerate() {
                    let requester = if command == "rename_session_user"
                        && entry["requester_name"] == fields["current_name"]
                    {
                        &fields["new_name"]
                    } else {
                        &entry["requester_name"]
                    };
                    let fixed = (command != "resort_playlist_by_cycle"
                        && entry["queue_slot_type"] != "cycle")
                        || !rows(&after["session_users"]).contains(requester);
                    if fixed {
                        assert_eq!(after["playlist"][index]["id"], entry["id"]);
                    }
                }
            }
        }
    }
    for name in [
        "move_session_user_to_index",
        "move_to_next",
        "add_item",
        "move_item_to_index",
        "add_session_user",
        "remove_session_user",
        "resort_playlist_by_cycle",
        "rename_session_user",
        "advance_to_next",
        "move_to_front",
    ] {
        assert!(counts[name] > 0);
    }
    assert!(stale > 0);
    eprintln!("playlist lifecycle: {seeds} seeds × {steps} steps; {counts:?}");
}

#[test]
fn random_lifecycle_checks_each_transition_payload_and_independent_schedule() {
    lifecycle(12, 180);
}

fn stress_count(name: &str, default: usize, maximum: usize) -> usize {
    let value = std::env::var(name).map_or(default, |value| {
        value.parse().expect("positive stress count")
    });
    assert!((1..=maximum).contains(&value), "invalid {name}");
    value
}

#[test]
#[ignore = "explicit larger native stress gate: 100 sessions × 500 steps"]
fn large_random_lifecycle_checks_each_transition_payload_and_independent_schedule() {
    lifecycle(
        stress_count("BILIKARA_PLAYLIST_STRESS_SEEDS", 100, 1000),
        stress_count("BILIKARA_PLAYLIST_STRESS_STEPS", 500, usize::MAX),
    );
}

fn concurrent_lifecycle(seed: u64) {
    let mut random = Random(seed);
    let users: Vec<_> = (0..random.pick(32) + 1).map(|i| format!("U{i}")).collect();
    let session = Session::new(&users.iter().map(String::as_str).collect::<Vec<_>>());
    let mut admitted = BTreeSet::new();
    for index in 0..17 {
        let id = format!("p{index:09}");
        session.add(&id, &users[index % users.len()], "tail");
        admitted.insert(id);
    }
    let barrier = Arc::new(Barrier::new(8));
    let threads:Vec<_>=(0..8).map(|worker|{let(session,barrier)=(session.clone(),barrier.clone());thread::spawn(move||{
        let mut random=Random(701200+worker);let mut successes=BTreeSet::new();barrier.wait();
        for step in 0..96 {
            let before=session.snapshot();let users=rows(&before["session_users"]);let queue=rows(&before["playlist"]);let choice=random.pick(8);let name=format!("U{}",random.pick(40));let id=format!("c{worker:02}{step:07}");
            let(command,fields)=match choice{
                0=>("add_session_user",json!({"name":name})),1=>("remove_session_user",json!({"name":name})),
                2=>("move_session_user_to_index",json!({"name":name,"target_index":random.pick(36) as i64-2})),
                3|4=>{let target=if queue.is_empty(){json!("missing")}else{queue[random.pick(queue.len())]["id"].clone()};if choice==3{("move_to_next",json!({"item_id":target}))}else{("move_item_to_index",json!({"item_id":target,"target_index":random.pick(queue.len()+5) as i64-2}))}},
                5=>("resort_playlist_by_cycle",json!({})),
                6=>("add_item",json!({"item":item(&id,&id),"requester_name":if users.is_empty(){json!(name)}else{users[random.pick(users.len())].clone()},"position":if random.pick(2)==0{"tail"}else{"next"},"allow_repeat":false,"reset_av_delay":false})),
                _=>("advance_to_next",json!({"expected_playback_generation":before["playback_generation"],"reset_av_delay":false})),
            };
            let response=session.attempt(command,fields);
            if response["status"]!="completed"{assert!(["duplicate_session_user","too_many_session_users","session_user_required","session_user_not_found","playback_generation_mismatch","queue_item_missing"].iter().any(|kind|response["error"]["kind"]==*kind),"{response}");continue;}
            if choice==6{successes.insert(id);}
            let snapshot=&response["snapshot"];let entries=active(snapshot);let ids:BTreeSet<_>=entries.iter().map(|e|e["id"].as_str().unwrap().to_owned()).collect();assert_eq!(entries.len(),ids.len());assert!(ids.is_disjoint(&ended(snapshot)));if response["committed"]==true&&choice!=6{assert_cycle(snapshot);}
        }
        successes
    })}).collect();
    for worker in threads {
        admitted.extend(worker.join().unwrap());
    }
    let snapshot = session.snapshot();
    let current: BTreeSet<_> = active(&snapshot)
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_owned())
        .collect();
    let retired = ended(&snapshot);
    assert!(current.is_disjoint(&retired));
    assert_eq!(
        current.union(&retired).cloned().collect::<BTreeSet<_>>(),
        admitted
    );
}

#[test]
fn concurrent_roster_admissions_reorders_and_next_conserve_every_success() {
    concurrent_lifecycle(118940);
}

#[test]
#[ignore = "explicit larger native concurrency gate: 8 sessions × 8 callers × 96 steps"]
fn large_concurrent_roster_admissions_reorders_and_next_conserve_every_success() {
    for seed in 0..stress_count("BILIKARA_PLAYLIST_STRESS_CONCURRENT", 8, usize::MAX) as u64 {
        concurrent_lifecycle(113 + seed * 7919);
    }
}

#[test]
fn returning_and_removed_singers_rejoin_without_losing_waiting_songs() {
    let session = Session::new(&["A", "B", "C"]);
    session.add("a0", "A", "tail");
    for round in 0..3 {
        session.add(&format!("b{round}"), "B", "tail");
        session.add(&format!("c{round}"), "C", "tail");
    }
    for _ in 0..6 {
        session.call("advance_to_next",json!({"expected_playback_generation":session.snapshot()["playback_generation"],"reset_av_delay":false}));
    }
    assert!(rows(&session.snapshot()["playlist"]).is_empty());
    session.add("b-return", "B", "tail");
    session.add("a-return", "A", "tail");
    assert_eq!(
        ids(&session.snapshot()["playlist"]),
        ["a-return", "b-return"]
    );
    let session = Session::new(&["A", "B", "C"]);
    for (id, user) in [("a0", "A"), ("b1", "B"), ("c1", "C"), ("b2", "B")] {
        session.add(id, user, "tail");
    }
    let before = session.snapshot();
    session.call("remove_session_user", json!({"name":"B"}));
    let orphaned = session.snapshot();
    for key in ["playlist", "current_item"] {
        assert_eq!(orphaned[key], before[key]);
    }
    session.call("add_session_user", json!({"name":"B"}));
    session.add("b3", "B", "tail");
    session.call("resort_playlist_by_cycle", json!({}));
    assert_eq!(
        ids(&session.snapshot()["playlist"]),
        ["c1", "b1", "b2", "b3"]
    );
}

fn rejects_unchanged(session: &Session, command: &str, fields: Value, kind: &str) {
    let before = session.snapshot();
    let result = session.attempt(command, fields);
    assert_eq!(result["error"]["kind"], kind, "{result}");
    assert_eq!(session.snapshot(), before);
}

#[test]
fn empty_full_roster_duplicates_and_started_history_reject_atomically() {
    let session = Session::new(&[]);
    rejects_unchanged(
        &session,
        "add_item",
        json!({"item":item("q0","q0"),"requester_name":"missing","position":"tail"}),
        "session_user_required",
    );
    for index in 0..32 {
        session.call("add_session_user", json!({"name":format!("U{index}")}));
    }
    for (name, kind) in [
        ("U32", "too_many_session_users"),
        (" U0 ", "duplicate_session_user"),
        (" \t ", "invalid_session_user"),
    ] {
        rejects_unchanged(&session, "add_session_user", json!({"name":name}), kind);
    }
    for started in [false, true] {
        let session = Session::new(&["A", "B"]);
        session.call(
            "add_item",
            json!({"item":item("a0","same"),"requester_name":"A","position":"tail"}),
        );
        rejects_unchanged(
            &session,
            "add_item",
            json!({"item":item("repeat","same"),"requester_name":"B","position":"tail"}),
            "duplicate_session_request",
        );
        session.call("add_item",json!({"item":item("repeat","same"),"requester_name":"B","position":"tail","allow_repeat":true}));
        let snapshot = session.snapshot();
        assert_ne!(
            snapshot["playlist"][0]["item_incarnation_id"],
            snapshot["current_item"]["item_incarnation_id"]
        );
        session.call("remove_item", json!({"item_id":"repeat"}));
        if started {
            session.call("mark_current_item_started", json!({"item_id":"a0"}));
        }
        session.call(
            "advance_to_next",
            json!({"expected_playback_generation":session.snapshot()["playback_generation"]}),
        );
        let after = session.snapshot();
        assert_eq!(after["session_played"][0]["item_id"], "a0");
        assert!(!after["session_played"][0]["ended_at"].is_null());
        assert_eq!(rows(&after["session_history"]).len(), usize::from(started));
        let fields = json!({"item":item("b0","same"),"requester_name":"B","position":"tail"});
        if started {
            rejects_unchanged(&session, "add_item", fields, "duplicate_session_request");
        } else {
            session.call("add_item", fields);
            assert_eq!(session.snapshot()["current_item"]["id"], "b0");
        }
    }
}

#[test]
fn missing_targets_clamped_positions_and_drag_token_preserve_other_programs() {
    let session = Session::new(&["A", "B", "C"]);
    for (id, user) in [("a0", "A"), ("a1", "A"), ("b1", "B"), ("c1", "C")] {
        session.add(id, user, "tail");
    }
    let before = session.snapshot();
    for (command, fields) in [
        ("move_to_next", json!({"item_id":"missing"})),
        (
            "move_item_to_index",
            json!({"item_id":"missing","target_index":1}),
        ),
    ] {
        rejects_unchanged(&session, command, fields, "queue_item_missing");
    }
    assert_eq!(
        session.call(
            "move_session_user_to_index",
            json!({"name":"missing","target_index":1})
        )["committed"],
        false
    );
    assert_eq!(session.snapshot(), before);
    rejects_unchanged(
        &session,
        "add_item",
        json!({"item":item("b1","different"),"requester_name":"C","position":"tail","allow_repeat":true}),
        "duplicate_item_id",
    );
    session.call(
        "move_item_to_index",
        json!({"item_id":"a1","target_index":-999}),
    );
    assert_eq!(session.snapshot()["playlist"][0]["id"], "a1");
    session.call(
        "move_item_to_index",
        json!({"item_id":"b1","target_index":999}),
    );
    assert_eq!(
        rows(&session.snapshot()["playlist"]).last().unwrap()["id"],
        "b1"
    );
    session.call("move_to_next", json!({"item_id":"b1"}));
    let topped = session.snapshot();
    let noop = session.call(
        "move_item_to_index",
        json!({"item_id":"b1","target_index":0}),
    );
    assert_eq!(noop["committed"], false);
    assert_eq!(noop["snapshot"], topped);
    assert_eq!(topped["playlist"][0]["queue_slot_type"], "priority");
    assert_eq!(topped["current_item"], before["current_item"]);
    let version = topped["queue_version"].clone();
    session.call("set_volume", json!({"volume_percent":57}));
    session.call(
        "update_item",
        json!({"item_id":"a1","changes":{"title":"Metadata changed"}}),
    );
    let selected = rows(&session.snapshot()["playlist"])
        .iter()
        .find(|e| e["id"] == "a1")
        .unwrap()
        .clone();
    let attempt=session.wire(json!({"schema_version":1,"command":"begin_cache_attempt","item_id":"a1","expected_item_incarnation_id":selected["item_incarnation_id"]}));
    assert_eq!(attempt["status"], "completed");
    session.call("apply_cache_event",json!({"item_id":"a1","cache_attempt_token":attempt["result"]["cache_attempt_token"],"event":{"kind":"queued","message":"Caching"}}));
    assert_eq!(session.snapshot()["queue_version"], version);
    let index = rows(&session.snapshot()["playlist"])
        .iter()
        .position(|e| e["id"] == "a1")
        .unwrap();
    assert_eq!(
        session.call(
            "move_item_to_index",
            json!({"item_id":"a1","target_index":index,"expected_queue_version":version})
        )["committed"],
        false
    );
    session.call("move_to_next", json!({"item_id":"a1"}));
    let changed = session.snapshot();
    assert_ne!(changed["queue_version"], version);
    rejects_unchanged(
        &session,
        "move_item_to_index",
        json!({"item_id":"b1","target_index":0,"expected_queue_version":version}),
        "queue_changed",
    );
    for (command, fields) in [
        ("move_to_next", json!({"item_id":"a0"})),
        (
            "move_item_to_index",
            json!({"item_id":"a0","target_index":0}),
        ),
        ("move_to_front", json!({"item_id":"a0"})),
    ] {
        rejects_unchanged(&session, command, fields, "queue_item_missing");
    }
    session.call("remove_item", json!({"item_id":"a1"}));
    session.add("a1", "A", "tail");
    assert_ne!(
        session.snapshot()["queue_version"],
        changed["queue_version"]
    );
}

#[test]
fn public_full_queue_projects_all_rows_and_rejects_stale_drag_intents() {
    let session = Session::new(&["A"]);
    let playlist: Vec<_> = (0..10000)
        .map(|i| item(&format!("p{i:09}"), &format!("p{i:09}")))
        .collect();
    let history:Vec<_>=(0..1001).map(|i|json!({"key":format!("h{i}:p1"),"display_title":format!("Song {i}"),"original_url":"","resolved_url":"","requested_at":1.0})).collect();
    session.initialize(json!({"session_users":["A"],"session_started_at":1.0,"session_played_file":"public.json","updated_at":1.0,"playlist":playlist,"history":history}));
    let public=session.wire(json!({"schema_version":1,"command":"internet_remote_state"}))["result"]["remote_state"].clone();
    assert_eq!(rows(&public["playlist"]).len(), 10000);
    assert_eq!(rows(&public["history"]).len(), 1001);
    assert_eq!(
        ids(&public["playlist"]),
        ids(&session.snapshot()["playlist"])
    );
    let opened=session.wire(json!({"schema_version":1,"command":"open_internet_remote_peer","peer_id":"guard-test","epoch":"abcdefghijklmnopqrstuv","profile":"controller"}));
    assert_eq!(opened["status"], "completed");
    let mut seq = 0;
    let mut send = |kind: &str, body: Value| {
        seq += 1;
        session.attempt("dispatch_internet_remote_message",json!({"peer_id":"guard-test","lane":"control","message":json!({"v":1,"lane":"control","epoch":"abcdefghijklmnopqrstuv","seq":seq,"id":format!("00000000-0000-4000-8000-{seq:012}"),"kind":kind,"body":body}).to_string()}))
    };
    assert_eq!(
        send("session.set_identity", json!({"name":"A"}))["status"],
        "completed"
    );
    let before = session.snapshot();
    session.call("set_muted", json!({"is_muted":true}));
    let moved = send(
        "playlist.move",
        json!({"item_id":"p000000000","target_index":9999,"expected_revision":before["revision"],"expected_queue_version":before["queue_version"]}),
    );
    assert_eq!(moved["result"]["accepted"], true);
    assert_eq!(rows(&moved["result"]["data"]["playlist"]).len(), 10000);
    assert_eq!(
        rows(&moved["result"]["data"]["playlist"]).last().unwrap()["id"],
        "p000000000"
    );
    let stale = send(
        "playlist.move",
        json!({"item_id":"p000000001","target_index":9998,"expected_revision":session.snapshot()["revision"],"expected_queue_version":before["queue_version"]}),
    );
    assert_eq!(stale["result"]["accepted"], false);
    assert_eq!(stale["result"]["code"], "queue_changed");
    let after = session.snapshot();
    let missing = send(
        "playlist.move_next",
        json!({"item_id":"missing","expected_revision":after["revision"]}),
    );
    assert_eq!(missing["error"]["kind"], "queue_item_missing");
    assert_eq!(session.snapshot(), after);
}

#[test]
fn concurrent_last_slot_includes_current_and_rejects_both_admission_positions() {
    let session = Session::new(&["A"]);
    let playlist: Vec<_> = (1..9999)
        .map(|i| item(&format!("p{i:09}"), &format!("p{i:09}")))
        .collect();
    session.initialize(json!({"session_users":["A"],"session_started_at":1.0,"session_played_file":"capacity.json","updated_at":1.0,"current_item":item("p000000000","p000000000"),"playlist":playlist}));
    let before = session.snapshot();
    let barrier = Arc::new(Barrier::new(8));
    let threads:Vec<_>=(0..8).map(|worker|{let(session,barrier)=(session.clone(),barrier.clone());thread::spawn(move||{barrier.wait();let id=format!("e{worker:09}");let result=session.attempt("add_item",json!({"item":item(&id,&id),"requester_name":"A","position":if worker%2==0{"tail"}else{"next"}}));if result["status"]=="completed"{true}else{assert_eq!(result["error"]["kind"],"too_many_items");false}})}).collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>(),
        1
    );
    let full = session.snapshot();
    let entries = active(&full);
    assert_eq!(entries.len(), 10000);
    assert_eq!(
        entries
            .iter()
            .map(|e| e["id"].to_string())
            .collect::<BTreeSet<_>>()
            .len(),
        10000
    );
    assert_eq!(
        full["revision"].as_u64().unwrap(),
        before["revision"].as_u64().unwrap() + 1
    );
    assert_eq!(full["current_item"], before["current_item"]);
    for position in ["tail", "next"] {
        rejects_unchanged(
            &session,
            "add_item",
            json!({"item":item("overflow","overflow"),"requester_name":"A","position":position,"allow_repeat":true}),
            "too_many_items",
        );
    }
}
