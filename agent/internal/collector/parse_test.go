package collector

import (
	"reflect"
	"testing"
)

func TestParseCPUStat(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    CPUStat
		wantErr bool
	}{
		{
			name: "modern kernel with guest columns",
			in: "cpu  10 1 5 100 2 0 3 0 7 0\n" +
				"cpu0 6 1 3 50 1 0 2 0 7 0\n" +
				"cpu1 4 0 2 50 1 0 1 0 0 0\n" +
				"intr 12345 0\nctxt 999\n",
			want: CPUStat{
				Total: CPUTimes{User: 10, Nice: 1, System: 5, Idle: 100, IOWait: 2, SoftIRQ: 3},
				PerCore: []CPUTimes{
					{User: 6, Nice: 1, System: 3, Idle: 50, IOWait: 1, SoftIRQ: 2},
					{User: 4, System: 2, Idle: 50, IOWait: 1, SoftIRQ: 1},
				},
			},
		},
		{
			name: "old kernel with four columns",
			in:   "cpu 1 2 3 4\ncpu0 1 2 3 4\n",
			want: CPUStat{
				Total:   CPUTimes{User: 1, Nice: 2, System: 3, Idle: 4},
				PerCore: []CPUTimes{{User: 1, Nice: 2, System: 3, Idle: 4}},
			},
		},
		{
			name: "steal column",
			in:   "cpu 1 0 1 10 0 0 0 9\n",
			want: CPUStat{Total: CPUTimes{User: 1, System: 1, Idle: 10, Steal: 9}},
		},
		{name: "missing aggregate line", in: "cpu0 1 2 3 4\n", wantErr: true},
		{name: "too few columns", in: "cpu 1 2 3\n", wantErr: true},
		{name: "non-numeric counter", in: "cpu 1 2 x 4\n", wantErr: true},
		{name: "empty", in: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseCPUStat([]byte(tt.in))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestParseMemInfo(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    MemInfo
		wantErr bool
	}{
		{
			name: "full",
			in:   "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n",
			want: MemInfo{TotalBytes: 1024000, AvailableBytes: 614400, SwapTotalBytes: 204800, SwapFreeBytes: 153600},
		},
		{
			name: "no swap lines",
			in:   "MemTotal: 1000 kB\nMemAvailable: 600 kB\n",
			want: MemInfo{TotalBytes: 1024000, AvailableBytes: 614400},
		},
		{name: "no MemAvailable", in: "MemTotal: 1000 kB\nMemFree: 600 kB\n", wantErr: true},
		{name: "no MemTotal", in: "MemAvailable: 600 kB\n", wantErr: true},
		{name: "bad number", in: "MemTotal: lots kB\nMemAvailable: 600 kB\n", wantErr: true},
		{name: "missing value", in: "MemTotal:\nMemAvailable: 600 kB\n", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseMemInfo([]byte(tt.in))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseLoadAverage(t *testing.T) {
	tests := []struct {
		in      string
		want    LoadAverage
		wantErr bool
	}{
		{in: "0.42 0.35 0.30 2/412 18734\n", want: LoadAverage{One: 0.42, Five: 0.35, Fifteen: 0.30}},
		{in: "12.00 8.50 4.25", want: LoadAverage{One: 12, Five: 8.5, Fifteen: 4.25}},
		{in: "0.42 0.35", wantErr: true},
		{in: "0.42 x 0.30 1/1 1", wantErr: true},
	}
	for _, tt := range tests {
		got, err := parseLoadAverage([]byte(tt.in))
		if (err != nil) != tt.wantErr {
			t.Fatalf("%q: err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("%q: got %+v, want %+v", tt.in, got, tt.want)
		}
	}
}

func TestParseUptime(t *testing.T) {
	tests := []struct {
		in      string
		want    float64
		wantErr bool
	}{
		{in: "90922.47 344195.81\n", want: 90922.47},
		{in: "5.00", want: 5},
		{in: "", wantErr: true},
		{in: "soon 1.0", wantErr: true},
	}
	for _, tt := range tests {
		got, err := parseUptime([]byte(tt.in))
		if (err != nil) != tt.wantErr {
			t.Fatalf("%q: err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("%q: got %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestParseNetDev(t *testing.T) {
	const header = "Inter-|   Receive                                                |  Transmit\n" +
		" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
	tests := []struct {
		name    string
		in      string
		want    []NetCounters
		wantErr bool
	}{
		{
			name: "filters virtual interfaces and sorts",
			in: header +
				"  wlan0: 300 3 0 0 0 0 0 0 30 3 0 0 0 0 0 0\n" +
				"    lo: 999 9 0 0 0 0 0 0 999 9 0 0 0 0 0 0\n" +
				"  eth0: 100 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n" +
				"docker0: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n" +
				"veth1a2b: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n" +
				"br-0123abcd: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0\n",
			want: []NetCounters{
				{Interface: "eth0", RxBytes: 100, TxBytes: 10},
				{Interface: "wlan0", RxBytes: 300, TxBytes: 30},
			},
		},
		{
			name: "no space after colon on large counters",
			in:   header + "  eth0:18446744073709551615 1 0 0 0 0 0 0 42 1 0 0 0 0 0 0\n",
			want: []NetCounters{{Interface: "eth0", RxBytes: 18446744073709551615, TxBytes: 42}},
		},
		{name: "only loopback", in: header + "    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n"},
		{name: "truncated line", in: header + "  eth0: 100 1 0 0\n", wantErr: true},
		{name: "bad rx", in: header + "  eth0: x 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n", wantErr: true},
		{name: "bad tx", in: header + "  eth0: 1 1 0 0 0 0 0 0 -1 1 0 0 0 0 0 0\n", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseNetDev([]byte(tt.in))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseOSRelease(t *testing.T) {
	tests := []struct{ in, want string }{
		{in: "NAME=\"Debian\"\nPRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\n", want: "Debian GNU/Linux 13 (trixie)"},
		{in: "PRETTY_NAME='Raspbian GNU/Linux 11 (bullseye)'\n", want: "Raspbian GNU/Linux 11 (bullseye)"},
		{in: "PRETTY_NAME=Alpine\n", want: "Alpine"},
		{in: "  PRETTY_NAME=\"Indented\"  \n", want: "Indented"},
		{in: "PRETTY_NAME=\"unbalanced\n", want: "\"unbalanced"},
		{in: "# comment\nNAME=Foo\n", want: ""},
		{in: "", want: ""},
	}
	for _, tt := range tests {
		if got := parseOSRelease([]byte(tt.in)); got != tt.want {
			t.Errorf("parseOSRelease(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestParseThrottled(t *testing.T) {
	tests := []struct {
		in      string
		want    uint32
		wantErr bool
	}{
		{in: "0\n", want: 0},
		{in: "50005\n", want: 0x50005},
		{in: "throttled=0x50005\n", want: 0x50005},
		{in: "throttled=0x0", want: 0},
		{in: "0XE000F", want: 0xe000f},
		{in: "", wantErr: true},
		{in: "throttled=", wantErr: true},
		{in: "zz", wantErr: true},
		{in: "1ffffffff", wantErr: true}, // does not fit in 32 bits
	}
	for _, tt := range tests {
		got, err := parseThrottled(tt.in)
		if (err != nil) != tt.wantErr {
			t.Fatalf("%q: err = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("%q: got %#x, want %#x", tt.in, got, tt.want)
		}
	}
}

func TestTrimValue(t *testing.T) {
	tests := []struct{ in, want string }{
		{in: "Raspberry Pi 5 Model B Rev 1.0\x00", want: "Raspberry Pi 5 Model B Rev 1.0"},
		{in: "Raspberry Pi 4 Model B Rev 1.5\x00\n", want: "Raspberry Pi 4 Model B Rev 1.5"},
		{in: "6.6.51+rpt-rpi-2712\n", want: "6.6.51+rpt-rpi-2712"},
		{in: "\x00", want: ""},
	}
	for _, tt := range tests {
		if got := trimValue([]byte(tt.in)); got != tt.want {
			t.Errorf("trimValue(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
