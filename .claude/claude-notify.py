"""
Claude Code Notify - Enhanced notification system with ntfy integration
Adapted from macOS terminal-notifier version to use ntfy for cross-platform notifications
Features delayed notifications with activity detection to avoid interrupting active sessions
"""

import os
import sys
import json
import sqlite3
import subprocess
import logging
import time
import functools
import platform
import multiprocessing
from logging.handlers import TimedRotatingFileHandler
from datetime import datetime, timezone, timedelta

# Python 3.9+ has zoneinfo, fallback to UTC for older versions
try:
    from zoneinfo import ZoneInfo
except ImportError:
    # Fallback for Python < 3.9
    class ZoneInfo:
        def __init__(self, key):
            self.key = key
            
        def __repr__(self):
            return f"ZoneInfo({self.key})"
    
    # For older Python versions, we'll use UTC as fallback
    import warnings
    warnings.warn("zoneinfo not available, timezone support limited to UTC", ImportWarning)

# Windows compatibility imports
if platform.system() == 'Windows':
    import psutil
else:
    import signal


def safe_db_operation(func):
    """Decorator for safe database operations with better error handling"""
    @functools.wraps(func)
    def wrapper(self, *args, **kwargs):
        conn = None
        try:
            conn = sqlite3.connect(self.db_path, timeout=30.0)
            # Use DELETE mode instead of WAL for fork compatibility
            conn.execute("PRAGMA journal_mode=DELETE")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=30000")
            result = func(self, conn, *args, **kwargs)
            conn.commit()
            return result
        except sqlite3.OperationalError as e:
            error_msg = f"Database operation failed: {str(e)}"
            print(error_msg, file=sys.stderr)
            logging.error(error_msg)
            return None
        except Exception as e:
            if conn:
                conn.rollback()
            error_msg = f"Unexpected database error: {str(e)}"
            print(error_msg, file=sys.stderr)
            logging.error(error_msg)
            raise  # Re-raise to trigger main error handler
        finally:
            if conn:
                conn.close()
    return wrapper


def is_process_running(pid):
    """Check if a process is still running"""
    if platform.system() == 'Windows':
        try:
            process = psutil.Process(pid)
            return process.is_running()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False
    else:
        try:
            os.kill(pid, 0)  # Signal 0 = check if process exists
            return True
        except (ProcessLookupError, PermissionError):
            return False


def setup_signal_handlers():
    """Setup signal handlers to prevent zombie processes"""
    if platform.system() != 'Windows':
        def sigchld_handler(signum, frame):
            # Reap any dead child processes
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        break
                    logging.info(f"Reaped child process {pid}")
                except OSError:
                    break

        signal.signal(signal.SIGCHLD, sigchld_handler)
    # On Windows, child processes are handled automatically


def spawn_watcher_process(notification_id):
    """Spawn watcher process with cross-platform compatibility"""
    try:
        if platform.system() == 'Windows':
            # Use multiprocessing on Windows
            process = multiprocessing.Process(
                target=watch_and_send_notification,
                args=(notification_id,)
            )
            process.start()
            return process.pid
        else:
            # Use fork on Unix-like systems
            pid = os.fork()
            if pid == 0:  # Child process
                # Child: become process group leader to avoid zombies
                os.setsid()

                # Reset signal handlers in child
                signal.signal(signal.SIGCHLD, signal.SIG_DFL)

                # Execute watcher function
                try:
                    watch_and_send_notification(notification_id)
                except Exception as e:
                    logging.error(f"Watcher process error: {e}")
                finally:
                    sys.exit(0)  # Child always exits cleanly
            else:
                # Parent: record the PID for potential cleanup
                return pid
    except OSError as e:
        error_msg = f"Failed to spawn watcher process: {str(e)}"
        print(error_msg, file=sys.stderr)
        logging.error(error_msg)
        return None


class ClaudePromptTracker:
    def __init__(self):
        """Initialize the prompt tracker with database setup"""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        self.db_path = os.path.join(script_dir, "claude-notify.db")
        self.config_path = os.path.join(script_dir, "claude-notify-config.json")
        
        # Load configuration
        self.config = self._load_config()
        
        # Set notification settings with env overrides
        self.ntfy_topic = os.environ.get('CLAUDE_NTFY_TOPIC', self.config['notifications']['ntfy_topic'])
        self.ntfy_icon = os.environ.get('CLAUDE_NTFY_ICON', self.config['notifications']['ntfy_icon'])
        self.notify_delay = int(os.environ.get('CLAUDE_NOTIFY_DELAY', str(self.config['notifications']['notify_delay'])))
        self.activity_window = int(os.environ.get('CLAUDE_ACTIVITY_WINDOW', str(self.config['notifications']['activity_window'])))
        
        # Working hours settings with env overrides
        self.working_hours_enabled = os.environ.get('CLAUDE_WORKING_HOURS_ENABLED', str(self.config['working_hours']['enabled'])).lower() == 'true'
        self.working_hours_timezone = os.environ.get('CLAUDE_WORKING_HOURS_TIMEZONE', self.config['working_hours']['timezone'])
        self.working_hours_schedule = self.config['working_hours']['schedule']
        
        self.setup_logging()

        try:
            self.init_database()
            self.clean_stale_watchers()
        except Exception as e:
            error_msg = f"Failed to initialize database: {str(e)}"
            print(error_msg, file=sys.stderr)
            logging.error(error_msg)
            raise

    def _load_config(self):
        """Load configuration from JSON file with defaults"""
        default_config = {
            "working_hours": {
                "enabled": False,
                "timezone": "UTC",
                "schedule": {
                    "monday": {"start": "09:00", "end": "17:00"},
                    "tuesday": {"start": "09:00", "end": "17:00"},
                    "wednesday": {"start": "09:00", "end": "17:00"},
                    "thursday": {"start": "09:00", "end": "17:00"},
                    "friday": {"start": "09:00", "end": "17:00"},
                    "saturday": {"enabled": False},
                    "sunday": {"enabled": False}
                }
            },
            "notifications": {
                "ntfy_topic": "claude-code",
                "ntfy_icon": "https://claude.ai/images/claude_app_icon.png",
                "notify_delay": 30,
                "activity_window": 90,
                "notify_tool_activity": False
            }
        }
        
        try:
            if os.path.exists(self.config_path):
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    user_config = json.load(f)
                
                # Merge user config with defaults
                config = default_config.copy()
                if 'working_hours' in user_config:
                    config['working_hours'].update(user_config['working_hours'])
                    if 'schedule' in user_config['working_hours']:
                        config['working_hours']['schedule'].update(user_config['working_hours']['schedule'])
                if 'notifications' in user_config:
                    config['notifications'].update(user_config['notifications'])
                
                return config
            else:
                logging.info(f"Config file not found at {self.config_path}, using defaults")
                return default_config
        except (json.JSONDecodeError, IOError) as e:
            logging.error(f"Error loading config file {self.config_path}: {e}")
            logging.info("Using default configuration")
            return default_config

    def setup_logging(self):
        """Setup logging to file with daily rotation"""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        log_path = os.path.join(script_dir, "claude-notify.log")

        # Create a timed rotating file handler
        handler = TimedRotatingFileHandler(
            log_path,
            when='midnight',  # Rotate at midnight
            interval=1,       # Every 1 day
            backupCount=1,   # Keep 1 days of logs
            encoding='utf-8'
        )

        # Set the log format
        formatter = logging.Formatter(
            '%(asctime)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        handler.setFormatter(formatter)

        # Configure the root logger
        logger = logging.getLogger()
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)

    def init_database(self):
        """Create tables with better error handling and recovery"""
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                with sqlite3.connect(self.db_path, timeout=30.0) as conn:
                    # Use DELETE mode instead of WAL for fork compatibility
                    conn.execute("PRAGMA journal_mode=DELETE")
                    conn.execute("PRAGMA synchronous=NORMAL")
                    conn.execute("PRAGMA busy_timeout=30000")

                    # Create main table
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS prompt (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            session_id TEXT NOT NULL,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            prompt TEXT,
                            cwd TEXT,
                            seq INTEGER,
                            stoped_at DATETIME,
                            lastWaitUserAt DATETIME
                        )
                    """)

                    # Create notifications table for delayed notifications
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS notifications (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            session_id TEXT NOT NULL,
                            scheduled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                            send_after DATETIME NOT NULL,
                            message TEXT,
                            cwd TEXT,
                            notification_type TEXT,
                            context_info TEXT DEFAULT '{}',
                            sent BOOLEAN DEFAULT 0,
                            cancelled BOOLEAN DEFAULT 0,
                            watcher_pid INTEGER,
                            watcher_started_at DATETIME
                        )
                    """)

                    # Create indexes for better performance
                    conn.execute("""
                        CREATE INDEX IF NOT EXISTS idx_notifications_pending
                        ON notifications(sent, cancelled, send_after)
                    """)

                    # Create trigger for auto-incrementing seq
                    conn.execute("""
                        CREATE TRIGGER IF NOT EXISTS auto_increment_seq
                        AFTER INSERT ON prompt
                        FOR EACH ROW
                        BEGIN
                            UPDATE prompt
                            SET seq = (
                                SELECT COALESCE(MAX(seq), 0) + 1
                                FROM prompt
                                WHERE session_id = NEW.session_id
                            )
                            WHERE id = NEW.id;
                        END
                    """)

                    conn.commit()
                    logging.info("Database initialized successfully")
                    return  # Success, exit the retry loop

            except sqlite3.DatabaseError as e:
                error_msg = f"Database initialization failed (attempt {attempt + 1}): {str(e)}"
                print(error_msg, file=sys.stderr)
                logging.error(error_msg)

                if "malformed" in str(e).lower() or "corrupted" in str(e).lower():
                    # Try to remove corrupted database and recreate
                    try:
                        os.unlink(self.db_path)
                        logging.info("Removed corrupted database, will recreate")
                    except OSError:
                        pass

                if attempt == max_attempts - 1:
                    # Last attempt failed, re-raise
                    raise

                time.sleep(0.5)  # Wait before retrying

    def handle_user_prompt_submit(self, data):
        """Handle UserPromptSubmit event - insert new prompt record and cancel pending notifications"""
        session_id = data.get('session_id')
        prompt = data.get('prompt', '')
        cwd = data.get('cwd', '')

        self._record_prompt(session_id, prompt, cwd)
        self._cancel_recent_notifications(session_id, "user_activity")

        logging.info(f"Recorded prompt for session {session_id} and cancelled pending notifications")

    @safe_db_operation
    def _record_prompt(self, conn, session_id, prompt, cwd):
        """Record a new prompt in the database"""
        conn.execute("""
            INSERT INTO prompt (session_id, prompt, cwd)
            VALUES (?, ?, ?)
        """, (session_id, prompt, cwd))

    def handle_stop(self, data):
        """Handle Stop event - update completion time and send notification"""
        session_id = data.get('session_id')

        with sqlite3.connect(self.db_path) as conn:
            # Find the latest unfinished record for this session
            cursor = conn.execute("""
                SELECT id, created_at, cwd
                FROM prompt
                WHERE session_id = ? AND stoped_at IS NULL
                ORDER BY created_at DESC
                LIMIT 1
            """, (session_id,))

            row = cursor.fetchone()
            if row:
                record_id, created_at, cwd = row

                # Update completion time
                conn.execute("""
                    UPDATE prompt
                    SET stoped_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                """, (record_id,))
                conn.commit()

                # Get seq number and calculate duration
                cursor = conn.execute("SELECT seq FROM prompt WHERE id = ?", (record_id,))
                seq_row = cursor.fetchone()
                seq = seq_row[0] if seq_row else 1

                duration = self.calculate_duration_from_db(record_id)
                context = {
                    'type': 'task_completed',
                    'job_seq': seq,
                    'duration': duration
                }
                self.send_notification(
                    title=os.path.basename(cwd) if cwd else "Claude Task",
                    message=f"job#{seq} done, duration: {duration}",
                    cwd=cwd,
                    notification_context=context
                )

                logging.info(f"Task completed for session {session_id}, job#{seq}, duration: {duration}")

    def handle_notification(self, data):
        """Handle Notification event - schedule delayed notifications with enhanced context detection"""
        session_id = data.get('session_id')
        message = data.get('message', '')
        cwd = data.get('cwd', '')
        
        # Detect notification type from message content
        notification_type, context_info = self._detect_notification_context(message, data)
        
        # Schedule a delayed notification with enhanced context
        notification_id = self._schedule_notification(
            session_id, message, cwd, notification_type, context_info
        )
        if notification_id and self.notify_delay > 0:
            # Spawn background process to handle delayed sending
            spawn_watcher_process(notification_id)
            logging.info(f"Scheduled {notification_type} notification for session {session_id} (delay: {self.notify_delay}s)")
        elif notification_id:
            # Send immediately if delay is 0
            self._send_scheduled_notification(notification_id)

    def _detect_notification_context(self, message, data):
        """Detect notification context from message content and data"""
        message_lower = message.lower()
        
        # Check for permission requests
        permission_indicators = ['permission', 'allow', 'approve', 'confirm', 'authorize']
        if any(indicator in message_lower for indicator in permission_indicators):
            return 'permission', {
                'waiting_for': 'permission',
                'tool_name': data.get('tool_name', ''),
                'requires_approval': True
            }
        
        # Check for tool-specific waiting
        tool_indicators = ['bash', 'command', 'script', 'file', 'write', 'edit']
        if any(indicator in message_lower for indicator in tool_indicators):
            return 'waiting_tool', {
                'waiting_for': 'tool_completion',
                'tool_name': self._extract_tool_from_message(message),
                'requires_approval': False
            }
        
        # Default to general waiting
        return 'waiting', {
            'waiting_for': 'user_input',
            'tool_name': '',
            'requires_approval': False
        }
    
    def _extract_tool_from_message(self, message):
        """Extract tool name from notification message"""
        message_lower = message.lower()
        tool_keywords = {
            'bash': 'Bash',
            'command': 'Bash',
            'terminal': 'Bash',
            'write': 'Write',
            'edit': 'Edit',
            'file': 'Write',
            'search': 'Grep',
            'web': 'WebFetch'
        }
        
        for keyword, tool in tool_keywords.items():
            if keyword in message_lower:
                return tool
        
        return ''

    @safe_db_operation
    def _schedule_notification(self, conn, session_id, message, cwd, notification_type, context_info=None):
        """Schedule a notification for delayed delivery with context"""
        send_after = datetime.now() + timedelta(seconds=self.notify_delay)

        # Store context info as JSON string
        context_json = json.dumps(context_info) if context_info else '{}'

        cursor = conn.execute("""
            INSERT INTO notifications (session_id, send_after, message, cwd, notification_type, context_info)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (session_id, send_after, message, cwd, notification_type, context_json))

        return cursor.lastrowid

    def calculate_duration_from_db(self, record_id):
        """Calculate duration for a completed record"""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute("""
                SELECT created_at, stoped_at
                FROM prompt
                WHERE id = ?
            """, (record_id,))

            row = cursor.fetchone()
            if row and row[1]:
                return self.calculate_duration(row[0], row[1])

        return "Unknown"

    def calculate_duration(self, start_time, end_time):
        """Calculate human-readable duration between two timestamps"""
        try:
            if isinstance(start_time, str):
                start_dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
            else:
                start_dt = datetime.fromisoformat(start_time)

            if isinstance(end_time, str):
                end_dt = datetime.fromisoformat(end_time.replace('Z', '+00:00'))
            else:
                end_dt = datetime.fromisoformat(end_time)

            duration = end_dt - start_dt
            total_seconds = int(duration.total_seconds())

            if total_seconds < 60:
                return f"{total_seconds}s"
            elif total_seconds < 3600:
                minutes = total_seconds // 60
                seconds = total_seconds % 60
                if seconds > 0:
                    return f"{minutes}m{seconds}s"
                else:
                    return f"{minutes}m"
            else:
                hours = total_seconds // 3600
                minutes = (total_seconds % 3600) // 60
                if minutes > 0:
                    return f"{hours}h{minutes}m"
                else:
                    return f"{hours}h"
        except Exception as e:
            logging.error(f"Error calculating duration: {e}")
            return "Unknown"

    def send_notification(self, title, message, cwd=None, notification_context=None):
        """Send enhanced notification using ntfy with rich content and actions"""
        # Check working hours before sending notification
        if not self._is_within_working_hours():
            logging.info(f"Notification suppressed - outside working hours: {title} - {message}")
            return
        
        from datetime import datetime
        current_time = datetime.now().strftime("%B %d, %Y at %H:%M")

        # Create rich notification message
        if cwd:
            project_name = os.path.basename(cwd)
            notification_title = f"[{project_name}] {title}" if title != project_name else f"[{project_name}]"
        else:
            notification_title = title

        # Get enhanced content based on context
        enhanced_content = self._get_enhanced_notification_content(
            title, message, cwd, notification_context
        )

        # Combine message with timestamp in plain text format
        full_message = f"{enhanced_content['message']} ({current_time})"

        try:
            # Check if ntfy is available
            if not self._check_command('ntfy'):
                logging.warning("ntfy command not found, notification skipped")
                return

            cmd = [
                'ntfy', 'publish',
                '--title', enhanced_content['title'],
                '--tags', enhanced_content['tags'],
                '--icon', self.ntfy_icon,
                '--click', enhanced_content['click_action'],
                '--priority', enhanced_content['priority']
            ]

            # Add action buttons if available
            if enhanced_content['actions']:
                cmd.extend(['--actions', enhanced_content['actions']])

            cmd.append(self.ntfy_topic)

            # Send the message via stdin
            result = subprocess.run(
                cmd,
                input=full_message,
                text=True,
                check=False,
                capture_output=True
            )

            if result.returncode == 0:
                logging.info(f"Enhanced notification sent: {enhanced_content['title']} - {enhanced_content['message']}")
            else:
                logging.error(f"ntfy failed with exit code {result.returncode}: {result.stderr}")

        except Exception as e:
            logging.error(f"Error sending notification: {e}")

    def _get_enhanced_notification_content(self, title, message, cwd=None, context=None):
        """Generate enhanced notification content with unique vibration patterns and clean formatting"""
        project_name = os.path.basename(cwd) if cwd else "Claude"
        
        # Default values
        enhanced = {
            'title': f"[{project_name}] {title}" if cwd else title,
            'message': self._format_message_plain(message),
            'tags': 'robot,gear',
            'click_action': 'ssh://hakim',
            'priority': '3',  # Use numeric priority (default)
            'actions': ''
        }

        # Context-specific enhancements with unique vibration patterns
        if context:
            notification_type = context.get('type', 'unknown')
            tool_name = context.get('tool_name', '')
            waiting_for = context.get('waiting_for', '')
            
            if notification_type == 'task_completed':
                enhanced.update({
                    'title': f"[{project_name}] Task Complete",
                    'message': self._format_completion_message(message),
                    'tags': 'white_check_mark,partying_face',
                    'priority': '3',  # Default vibration - satisfying completion
                    'actions': self._build_completion_actions(cwd)
                })
            
            elif notification_type == 'waiting_for_input':
                enhanced.update({
                    'title': f"[{project_name}] Waiting for Input",
                    'message': self._format_waiting_message(message, waiting_for),
                    'tags': 'hourglass_flowing_sand,warning',
                    'priority': '4',  # High priority - long vibration burst
                    'actions': self._build_input_actions(cwd, waiting_for, tool_name)
                })
            
            elif notification_type == 'tool_activity':
                enhanced.update({
                    'title': f"[{project_name}] Tool Activity",
                    'message': self._format_tool_message(tool_name, message),
                    'tags': f'{self._get_tool_tag(tool_name)},tools',
                    'priority': '2',  # Low priority - no vibration, subtle
                    'actions': self._build_tool_actions(cwd, tool_name)
                })
            
            elif notification_type == 'permission_request':
                enhanced.update({
                    'title': f"[{project_name}] Permission Required",
                    'message': self._format_permission_message(message, tool_name),
                    'tags': 'lock,warning,shield',
                    'priority': '5',  # Urgent - really long vibration bursts
                    'actions': self._build_permission_actions(cwd, tool_name)
                })

        return enhanced

    def _is_within_working_hours(self):
        """Check if current time is within configured working hours"""
        if not self.working_hours_enabled:
            return True
        
        try:
            # Get current time in the configured timezone
            if 'ZoneInfo' in globals() and hasattr(ZoneInfo, '__call__'):
                try:
                    tz = ZoneInfo(self.working_hours_timezone)
                    current_time = datetime.now(tz)
                except Exception:
                    # Fallback to UTC if timezone is invalid
                    current_time = datetime.now(timezone.utc)
                    logging.warning(f"Invalid timezone {self.working_hours_timezone}, using UTC")
            else:
                # Fallback for Python < 3.9
                current_time = datetime.now(timezone.utc)
                logging.warning("Using UTC as timezone fallback")
            
            # Get current day of week (lowercase)
            current_day = current_time.strftime('%A').lower()
            
            # Check if day is configured and enabled
            if current_day not in self.working_hours_schedule:
                return False
                
            day_config = self.working_hours_schedule[current_day]
            
            # Check if day is explicitly disabled
            if 'enabled' in day_config and not day_config['enabled']:
                return False
            
            # Check if start/end times are configured
            if 'start' not in day_config or 'end' not in day_config:
                return False
            
            # Parse start and end times
            start_time = datetime.strptime(day_config['start'], '%H:%M').time()
            end_time = datetime.strptime(day_config['end'], '%H:%M').time()
            current_time_only = current_time.time()
            
            # Check if current time is within working hours
            if start_time <= end_time:
                # Normal case: start time is before end time
                return start_time <= current_time_only <= end_time
            else:
                # Edge case: working hours span midnight
                return current_time_only >= start_time or current_time_only <= end_time
                
        except Exception as e:
            logging.error(f"Error checking working hours: {e}")
            # On error, allow notifications to prevent missing important ones
            return True

    def _format_message_plain(self, message):
        """Format a basic message in plain text"""
        return message

    def _format_completion_message(self, message):
        """Format completion message with celebration in plain text"""
        return f"🎉 {message} ✨ Task completed successfully!"

    def _format_waiting_message(self, message, waiting_for):
        """Format waiting message with context in plain text"""
        context_emoji = {
            'permission': '🔐',
            'user_input': '⌨️',
            'tool_completion': '🔧'
        }.get(waiting_for.lower(), '⏳')
        
        return f"{context_emoji} Waiting for Response: {message} - Please check your terminal"

    def _format_tool_message(self, tool_name, message):
        """Format tool activity message with tool-specific emoji in plain text"""
        tool_emoji = self._get_tool_emoji(tool_name)
        return f"{tool_emoji} {tool_name} completed: {message}"

    def _format_permission_message(self, message, tool_name):
        """Format permission message with urgency in plain text"""
        tool_emoji = self._get_tool_emoji(tool_name) if tool_name else '🔧'
        return f"🚨 PERMISSION REQUIRED 🚨 {tool_emoji} Tool: {tool_name} - {message} - Immediate attention needed"

    def _get_tool_emoji(self, tool_name):
        """Get appropriate emoji for different tools"""
        tool_emojis = {
            'Bash': '🐚',
            'Write': '📝',
            'Edit': '✏️',
            'Read': '📖',
            'Grep': '🔍',
            'Glob': '🗂️',
            'WebFetch': '🌐',
            'WebSearch': '🔎',
            'Task': '🤖',
            'LS': '📁',
            'TodoWrite': '✅',
            'MultiEdit': '📝',
            'NotebookEdit': '📓'
        }
        return tool_emojis.get(tool_name, '🔧')

    def _get_tool_tag(self, tool_name):
        """Get appropriate tag for different tools"""
        tool_tags = {
            'Bash': 'terminal',
            'Write': 'pencil',
            'Edit': 'pencil',
            'Read': 'books',
            'Grep': 'mag',
            'Glob': 'file_folder',
            'WebFetch': 'globe_with_meridians',
            'WebSearch': 'mag_right',
            'Task': 'robot',
            'LS': 'file_folder',
            'TodoWrite': 'white_check_mark',
            'MultiEdit': 'pencil',
            'NotebookEdit': 'notebook'
        }
        return tool_tags.get(tool_name, 'gear')

    def _build_completion_actions(self, cwd):
        """Build action buttons for task completion notifications"""
        # SSH connection action only
        return "view, 🔗 Connect, ssh://hakim, clear=true"

    def _build_input_actions(self, cwd, waiting_for, tool_name):
        """Build action buttons for input waiting notifications"""
        # High priority SSH connection only
        return "view, 🚀 Connect Now, ssh://hakim, clear=true"

    def _build_tool_actions(self, cwd, tool_name):
        """Build action buttons for tool activity notifications"""
        # SSH connection only
        return "view, 🔗 Connect, ssh://hakim, clear=false"

    def _build_permission_actions(self, cwd, tool_name):
        """Build action buttons for permission request notifications"""
        # Urgent SSH connection only
        return "view, 🚨 Connect URGENT, ssh://hakim, clear=true"

    def _check_command(self, command):
        """Check if a command is available in PATH"""
        try:
            subprocess.run([command, '--help'],
                         check=False,
                         capture_output=True,
                         timeout=5)
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False

    @safe_db_operation
    def _cancel_recent_notifications(self, conn, session_id, reason):
        """Cancel recent pending notifications due to user activity"""
        cutoff_time = datetime.now() - timedelta(seconds=self.activity_window)

        # Get PIDs of watchers to terminate
        cursor = conn.execute("""
            SELECT DISTINCT watcher_pid
            FROM notifications
            WHERE session_id = ?
              AND sent = 0
              AND cancelled = 0
              AND scheduled_at > ?
              AND watcher_pid IS NOT NULL
        """, (session_id, cutoff_time))

        watcher_pids = [row[0] for row in cursor.fetchall() if row[0]]

        # Cancel the notifications
        conn.execute("""
            UPDATE notifications
            SET cancelled = 1
            WHERE session_id = ?
              AND sent = 0
              AND cancelled = 0
              AND scheduled_at > ?
        """, (session_id, cutoff_time))

        # Terminate watcher processes
        for pid in watcher_pids:
            try:
                if platform.system() == 'Windows':
                    process = psutil.Process(pid)
                    process.terminate()
                else:
                    os.kill(pid, signal.SIGTERM)
                logging.info(f"Terminated watcher process {pid} due to {reason}")
            except (ProcessLookupError, PermissionError, psutil.NoSuchProcess, psutil.AccessDenied):
                # Process already dead or not accessible
                pass

    @safe_db_operation
    def clean_stale_watchers(self, conn=None):
        """Clean up watchers that are no longer running"""
        if conn is None:
            return self.clean_stale_watchers()

        # Get all active watchers
        cursor = conn.execute("""
            SELECT DISTINCT watcher_pid
            FROM notifications
            WHERE watcher_pid IS NOT NULL
              AND sent = 0
              AND cancelled = 0
              AND watcher_started_at > datetime('now', '-5 minutes')
        """)

        for (pid,) in cursor.fetchall():
            if pid and not is_process_running(pid):
                # Process is dead, clean it up
                conn.execute("""
                    UPDATE notifications
                    SET watcher_pid = NULL
                    WHERE watcher_pid = ?
                """, (pid,))
                logging.info(f"Cleaned up stale watcher process {pid}")

    def handle_post_tool_use(self, data):
        """Handle PostToolUse event - cancel pending notifications and optionally notify of tool activity"""
        session_id = data.get('session_id')
        tool_name = data.get('tool_name', '')
        cwd = data.get('cwd', '')

        self._cancel_recent_notifications(session_id, f"tool_activity_{tool_name}")
        
        # Optionally send tool activity notification for important tools
        important_tools = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch']
        if tool_name in important_tools and os.environ.get('CLAUDE_NOTIFY_TOOL_ACTIVITY', 'false').lower() == 'true':
            context = {
                'type': 'tool_activity',
                'tool_name': tool_name,
                'waiting_for': ''
            }
            self.send_notification(
                title="Tool Activity",
                message=f"{tool_name} completed",
                cwd=cwd,
                notification_context=context
            )
        
        logging.info(f"Cancelled pending notifications due to {tool_name} activity")

    @safe_db_operation
    def _send_scheduled_notification(self, conn, notification_id):
        """Send a scheduled notification if it hasn't been cancelled"""
        cursor = conn.execute("""
            SELECT session_id, message, cwd, notification_type, context_info, cancelled, sent
            FROM notifications
            WHERE id = ?
        """, (notification_id,))

        row = cursor.fetchone()
        if not row:
            return False

        session_id, message, cwd, notification_type, context_info, cancelled, sent = row

        if cancelled or sent:
            logging.info(f"Notification {notification_id} already cancelled/sent")
            return False

        # Mark as sent
        conn.execute("""
            UPDATE notifications
            SET sent = 1, watcher_pid = NULL
            WHERE id = ?
        """, (notification_id,))

        # Parse context info
        try:
            context_data = json.loads(context_info) if context_info else {}
        except json.JSONDecodeError:
            context_data = {}

        # Send the notification with enhanced context
        if notification_type == 'permission':
            title = os.path.basename(cwd) if cwd else 'Claude Task'
            display_message = f"Permission required: {message}"
            context = {
                'type': 'permission_request',
                'waiting_for': context_data.get('waiting_for', 'permission'),
                'tool_name': context_data.get('tool_name', '')
            }
        elif notification_type == 'waiting_tool':
            title = os.path.basename(cwd) if cwd else 'Claude Task'
            display_message = f"Tool waiting: {message}"
            context = {
                'type': 'waiting_for_input',
                'waiting_for': context_data.get('waiting_for', 'tool_completion'),
                'tool_name': context_data.get('tool_name', '')
            }
        elif notification_type == 'waiting':
            title = os.path.basename(cwd) if cwd else 'Claude Task'
            display_message = "Waiting for input"
            context = {
                'type': 'waiting_for_input',
                'waiting_for': context_data.get('waiting_for', 'user_input'),
                'tool_name': context_data.get('tool_name', '')
            }
        else:
            title = os.path.basename(cwd) if cwd else 'Claude Code'
            display_message = message
            context = {
                'type': 'general',
                'waiting_for': '',
                'tool_name': ''
            }

        self.send_notification(
            title=title, 
            message=display_message, 
            cwd=cwd, 
            notification_context=context
        )
        logging.info(f"Sent delayed notification {notification_id}: {display_message}")
        return True

    @safe_db_operation
    def _claim_notification(self, conn, notification_id):
        """Atomically claim a notification for watching"""
        cursor = conn.execute("""
            UPDATE notifications
            SET watcher_pid = ?, watcher_started_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND watcher_pid IS NULL
              AND sent = 0
              AND cancelled = 0
        """, (os.getpid(), notification_id))

        return cursor.rowcount > 0

    @safe_db_operation
    def _calculate_wait_time(self, conn, notification_id):
        """Calculate how long to wait before sending a notification"""
        cursor = conn.execute("""
            SELECT send_after
            FROM notifications
            WHERE id = ?
        """, (notification_id,))

        row = cursor.fetchone()
        if not row:
            return 0

        send_after = datetime.fromisoformat(row[0])
        now = datetime.now()

        if send_after <= now:
            return 0

        return int((send_after - now).total_seconds())

    @safe_db_operation
    def _is_notification_cancelled(self, conn, notification_id):
        """Check if a notification has been cancelled"""
        cursor = conn.execute("""
            SELECT cancelled
            FROM notifications
            WHERE id = ?
        """, (notification_id,))

        row = cursor.fetchone()
        return row and row[0] == 1


def validate_input_data(data, expected_event_name):
    """Validate input data matches design specification"""
    required_fields = {
        'UserPromptSubmit': ['session_id', 'prompt', 'cwd', 'hook_event_name'],
        'Stop': ['session_id', 'hook_event_name'],
        'Notification': ['session_id', 'message', 'hook_event_name'],
        'PostToolUse': ['session_id', 'tool_name', 'hook_event_name']
    }

    if expected_event_name not in required_fields:
        raise ValueError(f"Unknown event type: {expected_event_name}")

    # Check hook_event_name matches expected
    if data.get('hook_event_name') != expected_event_name:
        raise ValueError(f"Event name mismatch: expected {expected_event_name}, got {data.get('hook_event_name')}")

    # Check required fields
    missing_fields = []
    for field in required_fields[expected_event_name]:
        if field not in data or data[field] is None:
            missing_fields.append(field)

    if missing_fields:
        raise ValueError(f"Missing required fields for {expected_event_name}: {missing_fields}")

    return True


def watch_and_send_notification(notification_id):
    """Background process that waits and sends notification"""
    try:
        tracker = ClaudePromptTracker()

        # First, claim this notification atomically
        if not tracker._claim_notification(notification_id):
            # Another process is already watching this notification
            logging.info(f"Notification {notification_id} already has a watcher, exiting")
            return

        # Calculate actual wait time
        wait_time = tracker._calculate_wait_time(notification_id)
        if wait_time <= 0:
            # Should send immediately
            tracker._send_scheduled_notification(notification_id)
            return

        # Wait, but check periodically for cancellation
        check_interval = 1  # Check every second
        waited = 0
        while waited < wait_time:
            time.sleep(min(check_interval, wait_time - waited))
            waited += check_interval

            if tracker._is_notification_cancelled(notification_id):
                logging.info(f"Notification {notification_id} was cancelled during wait")
                return

        # Send the notification
        tracker._send_scheduled_notification(notification_id)

    except Exception as e:
        logging.error(f"Error in watcher process for notification {notification_id}: {e}")


def main():
    """Main entry point - read JSON from stdin and process event"""
    try:
        # Setup signal handlers first
        setup_signal_handlers()

        # Check if this is a watcher process call
        if len(sys.argv) >= 3 and sys.argv[1] == '--send-delayed':
            notification_id = int(sys.argv[2])
            watch_and_send_notification(notification_id)
            return

        # Check if hook type is provided as command line argument
        if len(sys.argv) < 2:
            error_msg = "Usage: claude-notify.py <event_type>\nValid event types: UserPromptSubmit, Stop, Notification, PostToolUse"
            print(error_msg, file=sys.stderr)
            logging.error(error_msg)
            sys.exit(1)

        expected_event_name = sys.argv[1]
        valid_events = ['UserPromptSubmit', 'Stop', 'Notification', 'PostToolUse']

        if expected_event_name not in valid_events:
            error_msg = f"Invalid hook type: {expected_event_name}. Valid types: {', '.join(valid_events)}"
            print(error_msg, file=sys.stderr)
            logging.error(error_msg)
            sys.exit(1)

        # Read JSON data from stdin
        input_data = sys.stdin.read().strip()
        if not input_data:
            error_msg = "No input data received from stdin"
            print(error_msg, file=sys.stderr)
            logging.warning(error_msg)
            sys.exit(1)

        data = json.loads(input_data)

        # Validate input data
        validate_input_data(data, expected_event_name)

        tracker = ClaudePromptTracker()

        if expected_event_name == 'UserPromptSubmit':
            tracker.handle_user_prompt_submit(data)
        elif expected_event_name == 'Stop':
            tracker.handle_stop(data)
        elif expected_event_name == 'Notification':
            tracker.handle_notification(data)
        elif expected_event_name == 'PostToolUse':
            tracker.handle_post_tool_use(data)

    except json.JSONDecodeError as e:
        error_msg = f"Invalid JSON input: {str(e)}"
        print(error_msg, file=sys.stderr)
        logging.error(error_msg)
        sys.exit(1)
    except ValueError as e:
        error_msg = f"Validation error: {str(e)}"
        print(error_msg, file=sys.stderr)
        logging.error(error_msg)
        sys.exit(1)
    except sqlite3.Error as e:
        error_msg = f"Database error: {str(e)}"
        print(error_msg, file=sys.stderr)
        logging.error(error_msg)
        sys.exit(1)
    except Exception as e:
        error_msg = f"Unexpected error: {str(e)}"
        print(error_msg, file=sys.stderr)
        logging.error(error_msg)
        sys.exit(1)


if __name__ == "__main__":
    # Required for multiprocessing on Windows
    if platform.system() == 'Windows':
        multiprocessing.freeze_support()
    main()