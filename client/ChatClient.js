if (typeof DEBUG === 'undefined') DEBUG = true; // will be removed

function ChatChannel (options) {

	var ChatChannelView = Backbone.View.extend({
		className: "chatChannel",
		template: _.template($("#chatpanelTemplate").html()),

		initialize: function (opts) {
			var self = this;

			_.bindAll(this);

			this.socket = io.connect("/chat");
			this.channelName = opts.room;
			this.autocomplete = new Autocomplete();
			this.users = new ClientsCollection();
			this.scrollback = new Scrollback();
			this.persistentLog = new Log({
				namespace: this.channelName
			});

			var chatLogView = new ChatLog();
			this.chatLog = new chatLogView({
				room: this.channelName
			});

			this.listen();
			this.render();
			this.attachEvents();

			// initialize the channel
			this.socket.emit("subscribe", {
				room: self.channelName
			}, this.postSubscribe);

			// if there's something in the persistent chatlog, render it:
			if (!this.persistentLog.empty()) {
				var entries = this.persistentLog.all();
				var renderedEntries = [];
				for (var i = 0, l = entries.length; i < l; i++) {
					var entry = this.chatLog.renderChatMessage(entries[i], {
						delayInsert: true
					});
					renderedEntries.push(entry);
				}
				this.chatLog.insertBatch(renderedEntries);
			}

			this.on("show", function () {
				self.$el.show();
				self.chatLog.scrollToLatest();
				$("textarea", self.$el).focus();
			});

			this.on("hide", function () {
				self.$el.hide();
			});
		},

		kill: function () {
			var self = this;

			_.each(this.socketEvents, function (method, key) {
				self.socket.removeAllListeners(key + ":" + self.channelName);
			});
			this.socket.emit("unsubscribe:" + this.channelName, {
				room: this.channelName
			});
		},

		postSubscribe: function (data) {
			var self = this;
			
			DEBUG && console.log("Subscribed", self.channelName);
			self.me = new ClientModel({}, {
				socket: self.socket
			});
			if (data) {
				self.me.cid = data.cid;				
			}

			self.me.bind("change:nick", function (attr) {
				self.socket.emit('nickname:' + self.channelName, {
					nickname: attr.changed.nick
				});
			});

			if ($.cookie("nickname:" + self.channelName)) {
				self.me.set("nick", $.cookie("nickname:" + self.channelName));
			}
		},

		render: function () {
			this.$el.html(this.template());
			$(".chatarea", this.$el).html(this.chatLog.$el);
			this.$el.attr("data-channel", this.channelName);
		},

		listen: function () {
			var self = this,
				socket = this.socket;
			DEBUG && console.log(self.channelName, "listening");

			this.socketEvents = {
				"chat": function (msg) {
					DEBUG && console.log(self.channelName, msg);
					switch (msg.class) {
						case "join":
							var newClient = new ClientModel(msg.client);
							newClient.cid = msg.cid;
							self.users.add(newClient);
							DEBUG && console.log("users now contains", self.users);
							break;
						case "part":
							// self.users.remove(msg.clientID);
							break;
					}

					// // scan through the message and determine if we need to notify somebody that was mentioned:
					if (typeof self.me !== "undefined") {
						if (msg.body.toLowerCase().indexOf(self.me.get("nick").toLowerCase()) !== -1) {
							DEBUG && console.log("@me", msg.body);
							notifications.notify(msg.nickname, msg.body.substring(0,50));
							msg.directedAtMe = true;
						}
					}

					self.persistentLog.add(msg); // TODO: log to a channel
					self.chatLog.renderChatMessage(msg);
				},
				"subscribed": function () {
					self.postSubscribe();
				},
				"chat:idle": function (msg) {
					DEBUG && console.log(msg);
					$(".user[rel='"+ msg.cID +"']", self.$el).append("<span class='idle' data-timestamp='" + Number(new Date()) +"'>Idle</span>");
				},
				"chat:unidle": function (msg) {
					$(".user[rel='"+ msg.cID +"'] .idle", self.$el).remove();
				},
				"chat:your_cid": function (msg) {
					DEBUG && console.log("my_cid:", msg.cid, "users I know about:", self.users);
					self.me = self.users.get(msg.cid);
				},
				"userlist": function (msg) {
					DEBUG && console.log("userlist",msg);
					// update the pool of possible autocompletes
					self.autocomplete.setPool(_.map(msg.users, function (user) {
						return user.nick;
					}));
					self.chatLog.renderUserlist(msg.users);

					_.each(msg.users, function (user) {
						// add to our list of clients
						// self.users.add({
						// 	client: user
						// });
					});
				},
				"chat:currentID": function (msg) {
					self.persistentLog.latestIs(msg.ID);
				},
				"topic": function (msg) {
					self.chatLog.setTopic(msg);
				}
			};

			_.each(this.socketEvents, function (value, key) {
				// listen to a subset of event
				socket.on(key + ":" + self.channelName, value);
			});

		},
		attachEvents: function () {
			var self = this;
			this.$el.on("keydown", ".chatinput textarea", function (ev) {
				$this = $(this);
				switch (ev.keyCode) {
					// enter:
					case 13:
						ev.preventDefault();
						var userInput = $this.val();
						self.scrollback.add(userInput);
						self.me.speak({
							body: userInput,
							room: self.channelName
						}, self.socket);
						$this.val("");
						self.scrollback.reset();
						break;
					// up:
					case 38:
						$this.val(self.scrollback.prev());
						break;
					// down
					case 40:
						$this.val(self.scrollback.next());
						break;
					// escape
					case 27:
						self.scrollback.reset();
						$this.val("");
						break;
					 // tab key
					case 9:
						ev.preventDefault();
						var text = $(this).val().split(" ");
						var stub = text[text.length - 1];				
						var completion = self.autocomplete.next(stub);

						if (completion !== "") {
							text[text.length - 1] = completion;
						}
						if (text.length === 1) {
							text[0] = text[0] + ", ";
						}

						$(this).val(text.join(" "));
						break;
				}

			});

			$(window).on("keydown mousemove", function () {
				if (self.$el.is(":visible")) {
					if (self.me) {
						self.me.active(self.channelName, self.socket);
						clearTimeout(self.idleTimer);
						self.startIdleTimer();						
					}
				}
			});

			this.startIdleTimer();

			this.$el.on("click", "button.syncLogs", function (ev) {
				ev.preventDefault();
				var missed = self.persistentLog.getMissingIDs(10);
				if (missed.length) {
					self.socket.emit("chat:history_request:" + self.channelName, {
					 	requestRange: missed
					});
				}
			});

			this.$el.on("click", "button.deleteLocalStorage", function (ev) {
				ev.preventDefault();
				self.persistentLog.destroy();
			});
		},

		startIdleTimer: function () {
			var self = this;
			this.idleTimer = setTimeout(function () {
				DEBUG && console.log("setting inactive");
				if (self.me) {
					self.me.inactive("", self.channelName, self.socket);
				}
			}, 1000*30);
		}
	});

	return ChatChannelView;
}