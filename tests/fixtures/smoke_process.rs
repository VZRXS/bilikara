// Private process/pipe fixture; never included in a product or upstream cache.
use std::{io::Write, process::Command, thread, time::Duration};

#[cfg(unix)]
unsafe extern "C" {
    fn close(fd: i32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}
#[cfg(target_os = "linux")]
unsafe extern "C" {
    fn prctl(option: i32, ...) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

#[cfg(target_os = "linux")]
fn supervise(args: &[String]) {
    // Reap test-owned grandchildren in containers whose PID 1 does not reap.
    // No process enumeration, unrelated signals or application behavior.
    assert_eq!(unsafe { prctl(36, 1_i32, 0_i32, 0_i32, 0_i32) }, 0);
    let child = Command::new(&args[0]).args(&args[1..]).spawn().unwrap();
    let child_id = child.id() as i32;
    let mut code = None;
    loop {
        let mut status = 0;
        let reaped = unsafe { waitpid(-1, &mut status, 0) };
        if reaped < 0 {
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(10));
            break;
        }
        if reaped == child_id {
            code = Some(if status & 127 == 0 {
                (status >> 8) & 255
            } else {
                1
            });
        }
    }
    std::process::exit(code.expect("supervised Node exited"));
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    #[cfg(target_os = "linux")]
    if args.first().is_some_and(|value| value == "supervise") {
        supervise(&args[1..]);
    }
    let mode = args.first().map(String::as_str).unwrap_or("ready");
    match mode {
        "ready" | "delayed" | "stderr" | "malformed" => {
            if mode == "delayed" {
                thread::sleep(Duration::from_millis(150));
            }
            if mode == "stderr" {
                eprintln!("warning");
            }
            if mode == "malformed" {
                println!("{{malformed");
            }
            println!("starting");
            println!("{{\"event\":\"bilikara.ready\",\"port\":4}}");
        }
        "exit" => {
            println!("before exit");
            std::process::exit(7);
        }
        "done" => println!("done"),
        "closed" => {
            #[cfg(unix)]
            unsafe {
                close(1);
                close(2);
            }
            thread::sleep(Duration::from_secs(30));
        }
        "waiting" => {
            println!("waiting");
            std::io::stdout().flush().unwrap();
            thread::sleep(Duration::from_secs(30));
        }
        "tree" | "leader-exits" => {
            let child = Command::new(std::env::current_exe().unwrap())
                .arg("descendant")
                .spawn()
                .unwrap();
            println!("{}", child.id());
            std::io::stdout().flush().unwrap();
            if mode == "tree" {
                #[cfg(unix)]
                unsafe {
                    signal(15, 1);
                }
                thread::sleep(Duration::from_secs(30));
            }
        }
        "descendant" => {
            #[cfg(unix)]
            unsafe {
                signal(15, 1);
            }
            thread::sleep(Duration::from_secs(30));
        }
        _ => panic!("unknown fixture mode"),
    }
}
