// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract GrantVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 21087153423893347558274959739853216802220455150401539869222348165704091244936;
    uint256 constant deltax2 = 1447682389491896846955364446583680340017693084121975841298478165619012585505;
    uint256 constant deltay1 = 3908447450000357093189822013028477273891243586680045954452369783996312545997;
    uint256 constant deltay2 = 11250389336156288731614162097499636247475545881700475213836222447385432567680;

    
    uint256 constant IC0x = 6721934193368794694635073498450417180896248493931989593948720327665163403297;
    uint256 constant IC0y = 17164728519527020522403587053679800433576094061252712301454981835247025345287;
    
    uint256 constant IC1x = 15951910072878056223645026880355695007969113189908155991812128943100317729850;
    uint256 constant IC1y = 4603116506752341992750765979535438191376531696594478291057717287591073969523;
    
    uint256 constant IC2x = 7247635497578927438128168625449800151202548221413163130748754951785117634;
    uint256 constant IC2y = 11570912940779370823694256608873424974301521968015761615037633841693932161698;
    
    uint256 constant IC3x = 15204850163803712094662819438606762405549376501905284172603200074379762766474;
    uint256 constant IC3y = 4559417208638367779719528467519805258687039169080462309966268086037245466918;
    
    uint256 constant IC4x = 13920248411878472887300911736091657452322308644771282975738313431084294755398;
    uint256 constant IC4y = 19622944787890255197389174005555670729143539443114678099132138139325409384544;
    
    uint256 constant IC5x = 1651348027415812679094028257131373781656506682987406253465550736095986192874;
    uint256 constant IC5y = 3472123221744074801461932016200971821531857003498334391822831382805482387733;
    
    uint256 constant IC6x = 12600753513989626051853179214935396242348631759690843157656726842269331410688;
    uint256 constant IC6y = 4643305528555283726916964917371221720906468511434046228560668759927802897768;
    
    uint256 constant IC7x = 2429420136053703760415258849100689955839088960189049555476940962024707305306;
    uint256 constant IC7y = 4613616197810714454618281946726413495690356783413816715185712654320904833296;
    
    uint256 constant IC8x = 2986461050188332842505164946764998560094438555907250204131114061827409738903;
    uint256 constant IC8y = 9167624508880704172446879686753267198229636464555347569734462963013041968517;
    
    uint256 constant IC9x = 17898236590104293162644089399346527925841389377974421628233670274921165358847;
    uint256 constant IC9y = 8966785418178794001637733334416691481173672284946497459766987560408262595764;
    
    uint256 constant IC10x = 4799147711264735341054557834328878433632287165777769644256814844057258180432;
    uint256 constant IC10y = 9103199415981501936686853439771276498150356417609369697944386964695467864531;
    
    uint256 constant IC11x = 4322027778319629596599039010360097690303285441260433265912499111241117028638;
    uint256 constant IC11y = 1800740412279790493056133234440169163479417977454000417631992408035484356619;
    
    uint256 constant IC12x = 7365129582429257908408274542809316005946062852278951358010371546774862522785;
    uint256 constant IC12y = 17577425205887149397055002691473388037558796532314256886342513079880191714559;
    
    uint256 constant IC13x = 706546631111088597625779034872306899220416189104483021414085028293706967711;
    uint256 constant IC13y = 17925277334588812840400923872969386945875179189115291433920301527023740655063;
    
    uint256 constant IC14x = 19682228513813286098449209133675408670061348849692724317875385586243929305214;
    uint256 constant IC14y = 20327358475336845825212349331945648633554670956211873201639817171994335713372;
    
    uint256 constant IC15x = 14711826151613555209912459300098744777515805934487140262509110816624277574347;
    uint256 constant IC15y = 6631018016075453658393006214860059135132300469829701750230142586083001505723;
    
    uint256 constant IC16x = 9023960627752230682752019716777010555458935062399814407673293066094337762779;
    uint256 constant IC16y = 3797928525976822765866056690732552862004581182481134241498217458595792196834;
    
    uint256 constant IC17x = 9588914659665099739087857100933956556005673804317540131501523818971335003542;
    uint256 constant IC17y = 8325832593148394212231813449804924570584210162677275793162378625428994594193;
    
    uint256 constant IC18x = 19421151224000048160925834390873141088187629820488884539781293133189249082896;
    uint256 constant IC18y = 18036178464364080923959227670839839373191965028005069500044581431159362883467;
    
    uint256 constant IC19x = 20459201854505828516279143939618494597713962574332724990363951999162673565242;
    uint256 constant IC19y = 20485703221104286921387742758408206851841596351122618872559665686084742789813;
    
    uint256 constant IC20x = 19449542162835715267501203696415343242860120619003982399735913726998627474732;
    uint256 constant IC20y = 10764522008495159675052282005520554594780931420997757707787058220164183622494;
    
    uint256 constant IC21x = 5205358822527427078596913442558262442677758574404728287501134324117012606587;
    uint256 constant IC21y = 13140614329666609943885372314120656675001567967615120036200402959339573799241;
    
    uint256 constant IC22x = 6963845656308259265705984216136496619491808665838111077417050489531833136903;
    uint256 constant IC22y = 20996417188609510585425703813191678278394643497679705602829731918849470120265;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[22] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                
                g1_mulAccC(_pVk, IC16x, IC16y, calldataload(add(pubSignals, 480)))
                
                g1_mulAccC(_pVk, IC17x, IC17y, calldataload(add(pubSignals, 512)))
                
                g1_mulAccC(_pVk, IC18x, IC18y, calldataload(add(pubSignals, 544)))
                
                g1_mulAccC(_pVk, IC19x, IC19y, calldataload(add(pubSignals, 576)))
                
                g1_mulAccC(_pVk, IC20x, IC20y, calldataload(add(pubSignals, 608)))
                
                g1_mulAccC(_pVk, IC21x, IC21y, calldataload(add(pubSignals, 640)))
                
                g1_mulAccC(_pVk, IC22x, IC22y, calldataload(add(pubSignals, 672)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            
            checkField(calldataload(add(_pubSignals, 480)))
            
            checkField(calldataload(add(_pubSignals, 512)))
            
            checkField(calldataload(add(_pubSignals, 544)))
            
            checkField(calldataload(add(_pubSignals, 576)))
            
            checkField(calldataload(add(_pubSignals, 608)))
            
            checkField(calldataload(add(_pubSignals, 640)))
            
            checkField(calldataload(add(_pubSignals, 672)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
